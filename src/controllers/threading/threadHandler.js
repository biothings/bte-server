const { MessageChannel, threadId } = require("worker_threads");
const debug = require("debug")("bte:biothings-explorer-trapi:threading");
const path = require("path");
// const taskHandler = require("./taskHandler");
const { redisClient } = require("@biothings-explorer/query_graph_handler");
const Piscina = require("piscina");
const { isWorkerThread } = require("piscina");
const EventEmitter = require("events");
const os = require("os");
const ServerOverloadedError = require("../../utils/errors/server_overloaded_error");
const { customAlphabet } = require("nanoid");
const { getQueryQueue } = require("../async/asyncquery_queue");

const { Telemetry } = require("@biothings-explorer/utils");
const ErrorHandler = require("../../middlewares/error.js");

const SYNC_MIN_CONCURRENCY = 2;
const ASYNC_MIN_CONCURRENCY = 3;

// On most instances, there are two nodes, one for Service Provider endpoints and one for everything else
// On Dev and local instances, this isn't the case, so a lower concurrency is needed
const CORE_CONCURRENCY_RATIO = parseInt(process.env.CORE_CONCURRENCY_RATIO ?? 2);
const MEM_CONCURRENCY_RATIO = parseFloat(process.env.MEM_CONCURRENCY_RATIO ?? 0.5);

const CORE_LIMIT = Math.ceil(os.cpus().length * CORE_CONCURRENCY_RATIO);

const MEM_LIMIT = Math.ceil((os.totalmem() / 2e9) * MEM_CONCURRENCY_RATIO);

// Ex. Prod: 16 cores / 64GB mem = min(16 * 2, 32) = 32 allowed concurrently
// Divided by 4 because each instance uses 4 sub-instances for reliability
let SYNC_CONCURRENCY = Math.ceil(Math.min(CORE_LIMIT, MEM_LIMIT) / 4);
if (SYNC_CONCURRENCY < SYNC_MIN_CONCURRENCY) SYNC_CONCURRENCY = SYNC_MIN_CONCURRENCY;

let ASYNC_CONCURRENCY = SYNC_CONCURRENCY;
if (ASYNC_CONCURRENCY < ASYNC_MIN_CONCURRENCY) ASYNC_CONCURRENCY = ASYNC_MIN_CONCURRENCY;

// Async has 3 separate queues, concurrency is distributed between them as such:
const ASYNC_MAIN_CONCURRENCY = ASYNC_CONCURRENCY;
const ASYNC_BY_API_CONCURRENCY = Math.ceil(ASYNC_CONCURRENCY / 2);
const ASYNC_BY_TEAM_CONCURRENCY = Math.ceil(ASYNC_CONCURRENCY / 2);

if (!global.threadpool && !isWorkerThread && !(process.env.USE_THREADING === "false")) {
  // Give user a little report of resource availability
  debug(`Computed core limit: ${CORE_LIMIT}`);
  debug(`Computed mem limit: ${MEM_LIMIT}`);
  debug(`Sync concurrency limit: ${SYNC_CONCURRENCY}`);
  debug(`Async concurrency limit: ${ASYNC_CONCURRENCY}`);
  const env = {
    ...process.env,
    DEBUG_COLORS: true,
  };
  global.threadpool = {
    /**Medium-volume, medium-intensity requests
     * Maximum threads equal to 1/4 CPUs as BTE usually runs 4 intances
     * Maximum queue set, so if the queue if full, requests will be dropped
     * Usually, queuing will be handled by Bull, but if Bull is unavailable
     * (e.g. local debugging w/o a Redis instance), queuing falls back to Piscina
     */
    sync: new Piscina({
      filename: path.resolve(__dirname, "./taskHandler.js"),
      minThreads: 2,
      maxThreads: SYNC_CONCURRENCY,
      maxQueue: 600,
      idleTimeout: 10 * 60 * 1000, // 10 minutes
      workerData: { queue: "sync" },
      env,
    }),
    /**Low-volume, high-intensity requests
     * No other settings since this queue is handled externally with Bull
     * High timeout because we expect near-constant use, so rather not kill the thread
     */
    async: new Piscina({
      filename: path.resolve(__dirname, "./taskHandler.js"),
      // e.g. 8 cores *
      maxThreads: ASYNC_CONCURRENCY,
      minThreads: 1,
      idleTimeout: 60 * 60 * 1000, // 1 hour
      workerData: { queue: "async" },
      env,
    }),
    /**High-volume, low-intensity requests
     * Expecting frequent use, so timeout is high
     */
    misc: new Piscina({
      filename: path.resolve(__dirname, "./taskHandler.js"),
      idleTimeout: 60 * 60 * 1000, // 1 hour
      minThreads: 2,
      maxQueue: 600,
      workerData: { queue: "misc" },
      env,
    }),
  };
}

const queueTaskToWorkers = async (pool, req, route, job) => {
  return new Promise(async (resolve, reject) => {
    let WorkerThreadID;
    const abortController = new AbortController();
    const { port1: toWorker, port2: fromWorker } = new MessageChannel();
    const taskData = { req, route, port: toWorker };
    if (job) taskData.job = { jobId: job.id, queueName: job.queue.name };
    const task = pool.run(taskData, { signal: abortController.signal, transferList: [toWorker] });
    if (job) {
      job.update({ ...job.data, abortController });
    }

    // catch failures that cause the worker to outright fail
    task.catch(error => {
      if (error.name === "AbortError") {
        debug(`Worker thread ${WorkerThreadID} terminated successfully.`);
      } else if (error.message === "Task queue is at limit") {
        debug(
          [pool === global.threadpool.sync ? "Synchronous" : "Misc", "server queue is at limit, job rejected."].join(
            " ",
          ),
        );
        const expectedWaitTime = Math.ceil(pool.waitTime.p99 / 1000) + 1;
        const message = [
          "The server is currently under heavy load.",
          ` Please try again after about ${expectedWaitTime}s`,
          pool === global.threadpool.sync ? ", or try using the asynchronous endpoints." : ".",
        ].join("");
        error = new ServerOverloadedError(message, expectedWaitTime);
      } else {
        debug(`Caught error in worker thread ${WorkerThreadID}, error below:`);
        debug(error);
      }
      reject(error);
    });
    let reqDone = false;
    let cacheInProgress = 0;
    let cacheKeys = {};
    const timeout = parseInt(process.env.REQUEST_TIMEOUT ?? (60 * 5).toString()) * 1000;
    fromWorker.on("message", ({ threadId, ...msg }) => {
      if (msg.cacheInProgress) {
        // cache handler has started caching
        cacheInProgress += 1;
      } else if (msg.addCacheKey) {
        // hashed edge id cache in progress
        cacheKeys[msg.cacheKey] = false;
      } else if (msg.completeCacheKey) {
        // hashed edge id cache complete
        cacheKeys[msg.cacheKey] = true;
      } else if (msg.registerId) {
        if (job) {
          WorkerThreadID = threadId;
          job.update({ ...job.data, threadId });
        }
      } else if (typeof msg.cacheDone !== "undefined") {
        cacheInProgress = msg.cacheDone
          ? cacheInProgress - 1 // a caching handler has finished caching
          : 0; // caching has been entirely cancelled
      } else if (typeof msg.result !== "undefined") {
        // request has finished with a message
        reqDone = true;
        resolve(msg);
      } else if (msg.err) {
        // request has resulted in a catchable error
        reqDone = true;
        reject(msg.err);
      }
      if (reqDone && cacheInProgress <= 0 && job) {
        job.progress(100);
      }
    });

    if (timeout && pool !== global.threadpool.async) {
      setTimeout(() => {
        // clean up any incompletely cached hashes to avoid issues pulling from cache
        const activeKeys = Object.entries(cacheKeys).filter(([key, complete]) => !complete);
        if (activeKeys.length) {
          try {
            redisClient.client.delTimeout(activeKeys);
          } catch (error) {
            null;
          }
        }
        abortController.abort();
        reject(
          new Error(
            `Request timed out (exceeded time limit of ${
              timeout / 1000
            }s). Please use the asynchronous endpoint (/v1/asyncquery) for long-running queries.`,
          ),
        );
      }, timeout);
    }
  });
};

async function runTask(req, task, route, res, useBullSync = true) {
  const queryQueue = global.queryQueue.bte_sync_query_queue;
  req = {
    data: {
      route,
      queryGraph: req.body.message?.query_graph,
      workflow: req.body.workflow,
      options: {
        logLevel: req.body.log_level,
        submitter: req.body.submitter,
        smartAPIID: req.params.smartapi_id,
        teamName: req.params.team_name,
        ...req.query,
      },
    },
    params: req.params,
    endpoint: req.originalUrl,
  };
  if (queryQueue && useBullSync) {
    const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 10);
    const jobId = nanoid();
    const jobOpts = {
      jobId,
      attempts: 1,
      timeout: undefined,
      removeOnFail: {
        age: 24 * 60 * 60, // keep failed jobs for a day (in case user needs to review fail reason)
        count: 2000,
      },
      removeOnComplete: {
        age: 90 * 24 * 60 * 60, // keep completed jobs for 90 days
        count: 2000,
      },
    };

    if ((await queryQueue.count()) >= 600) {
      const pool = global.threadpool.sync;
      const expectedWaitTime = Math.ceil(pool.waitTime.p99 / 1000) + 1;
      const message = [
        "The server is currently under heavy load.",
        ` Please try again after about ${expectedWaitTime}s`,
        ", or try using the asynchronous endpoints.",
      ].join("");
      throw new ServerOverloadedError(message, expectedWaitTime);
    }

    return new Promise(async (resolve, reject) => {
      const job = await queryQueue.add(req.data, jobOpts);
      try {
        const response = await job.finished();
        resolve(response);
      } catch (error) {
        // Have to reconstruct the error because Bull does some weirdness
        const jobLatest = await queryQueue.getJob(jobOpts.jobId);
        const reconstructedError = new Error();
        try {
          reconstructedError.name = jobLatest.stacktrace[0].split(":")[0];
          reconstructedError.message = jobLatest.stacktrace[0].split("\n")[0];
          reconstructedError.stack = jobLatest.stacktrace[0];
        } catch (constructionError) {
          reconstructedError.name = "ThreadingError";
          reconstructedError.message = JSON.stringify(jobLatest.stacktrace);
        }
        reject(reconstructedError);
      }
    });
  }
  // redis unavailable or query not to sync queue such as asyncquery_status
  if (!(process.env.USE_THREADING === "false")) {
    const response = await queueTaskToWorkers(
      useBullSync ? global.threadpool.sync : global.threadpool.misc,
      req,
      route,
    );
    if (typeof response.result !== "undefined") {
      if (response.status) {
        res?.status(response.status);
      }
      return response.result ? response.result : undefined; // null msg means keep response body empty
    } else if (response.err) {
      throw new response.err();
    } else {
      throw new Error("Threading Error: Task resolved without message");
    }
  }
  // threading disabled
  try {
    const response = await task(req);
    return response;
  } catch (error) {
    throw error;
  }
}

async function runBullTask(job, route, async = true) {
  const req = { id: job.id, data: { ...job.data } };
  return new Promise(async (resolve, reject) => {
    try {
      const response = await queueTaskToWorkers(
        async ? global.threadpool.async : global.threadpool.sync,
        req,
        route,
        job,
      );
      if (typeof response.result !== "undefined") {
        resolve(response.result ? response.result : undefined); // null result means keep response body empty
      } else if (response.err) {
        reject(response.err);
      } else {
        reject(new Error("Threading Error: Task resolved without message"));
      }
    } catch (error) {
      reject(error);
    }
  });
}

function taskResponse(response, status = undefined) {
  if (global.parentPort) {
    global.parentPort.postMessage({ threadId, result: response, status: status });
    return undefined;
  } else {
    return response;
  }
}

function taskError(error) {
  if (global.parentPort) {
    if (ErrorHandler.shouldHandleError(error)) {
      Telemetry.captureException(error);
    }
    global.parentPort.postMessage({ threadId, err: error });
    return undefined;
  } else {
    throw error;
  }
}

if (!global.queryQueue.bte_sync_query_queue && !isWorkerThread) {
  getQueryQueue("bte_sync_query_queue");
  if (global.queryQueue.bte_sync_query_queue) {
    global.queryQueue.bte_sync_query_queue.process(SYNC_CONCURRENCY, async job => {
      try {
        return await runBullTask(job, job.data.route, false);
      } catch (error) {
        throw error;
      }
    });
  }
}

// TODO merge async into one queue
if (!global.queryQueue.bte_query_queue && !isWorkerThread) {
  getQueryQueue("bte_query_queue");
  if (global.queryQueue.bte_query_queue) {
    global.queryQueue.bte_query_queue.process(ASYNC_MAIN_CONCURRENCY, async job => {
      return await runBullTask(job, "asyncquery_v1");
    });
  }
}

if (!global.queryQueue.bte_query_queue_by_api && !isWorkerThread) {
  getQueryQueue("bte_query_queue_by_api");
  if (global.queryQueue.bte_query_queue_by_api) {
    global.queryQueue.bte_query_queue_by_api.process(ASYNC_BY_API_CONCURRENCY, async job => {
      return await runBullTask(job, "asyncquery_v1_by_api");
    });
  }
}

if (!global.queryQueue.bte_query_queue_by_team && !isWorkerThread) {
  getQueryQueue("bte_query_queue_by_team");
  if (global.queryQueue.bte_query_queue_by_team) {
    global.queryQueue.bte_query_queue_by_team.process(ASYNC_BY_TEAM_CONCURRENCY, async job => {
      return await runBullTask(job, "asyncquery_v1_by_team");
    });
  }
}

module.exports = {
  runTask,
  runBullTask,
  taskResponse,
  taskError,
};
