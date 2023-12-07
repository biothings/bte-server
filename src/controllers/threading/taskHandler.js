const { isMainThread, threadId } = require("worker_threads");
const workerData = require("piscina").workerData;
const debug = require("debug")(`bte:biothings-explorer-trapi:worker${threadId}`);

if (!isMainThread) {
  // Log thread start before BioLink model loads
  debug(`Worker thread ${threadId} is ready to accept ${workerData.queue} tasks.`);
}

const { tasks } = require("../../routes/index");
const { getQueryQueue } = require("../async/asyncquery_queue");
const Sentry = require("@sentry/node");
const { ProfilingIntegration } = require("@sentry/profiling-node");

// use SENTRY_DSN environment variable
try {
  Sentry.init({
    integrations: [
      // Automatically instrument Node.js libraries and frameworks
      ...Sentry.autoDiscoverNodePerformanceMonitoringIntegrations(),
      new ProfilingIntegration(),
      // enable HTTP calls tracing
      new Sentry.Integrations.Http({ tracing: true }),
    ],
    environment: process.env.INSTANCE_ENV,
    debug: true,
    normalizeDepth: 6,
    maxBreadcrumbs: 500,
    // Set tracesSampleRate to 1.0 to capture 100%
    // of transactions for performance monitoring.
    // We recommend adjusting this value in production
    tracesSampleRate: process.env.THREAD_SAMPLE_RATE ? parseFloat(process.env.THREAD_SAMPLE_RATE) : 1.0,
    profilesSampleRate: process.env.THREAD_PROFILE_RATE ? parseFloat(process.env.THREAD_PROFILE_RATE) : 1.0, // Profiling sample rate is relative to tracesSampleRate,
    _experiments: {
      maxProfileDurationMs: 6 * 60 * 1000, // max profiling duration of 6 minutes (technically "beta" feature)
    },
  });
} catch (error) {
  debug("Sentry init error. This does not affect execution.");
  debug(error);
}

const runTask = async ({ req, route, port, job: { jobId, queueName } = {} }) => {
  debug(`Worker thread ${threadId} beginning ${workerData.queue} task.`);

  global.SCHEMA_VERSION = "1.4.0";

  global.parentPort = port;
  port.postMessage({ threadId, registerId: true });
  global.cachingTasks = [];

  global.queryInformation = {
    queryGraph: req?.body?.message?.query_graph,
  };

  if (queueName) {
    const queue = await getQueryQueue(queueName);
    global.job = await queue.getJob(jobId);
  }

  let transaction;
  try {
    const routeNames = {
      query_v1: "EXEC /v1/query",
      query_v1_by_api: "EXEC /v1/smartapi/:/query",
      query_v1_by_team: "EXEC /v1/team/:/query",
      asyncquery_status: "EXEC /v1/asyncquery_status",
      asyncquery_v1: "EXEC /v1/asyncquery",
      asyncquery_v1_by_api: "EXEC /v1/smartapi/:/asyncquery",
      asyncquery_v1_by_team: "EXEC /v1/team/:/asyncquery",
    };
    transaction = Sentry.startTransaction({ name: routeNames[route] });
    transaction.setData("request", req.data.queryGraph);
    Sentry.getCurrentHub().configureScope(scope => {
      scope.clearBreadcrumbs();
      scope.setSpan(transaction);
    });
  } catch (error) {
    debug("Sentry transaction start error. This does not affect execution.");
    debug(error);
  }

  const completedTask = await tasks[route](req);
  await Promise.all(global.cachingTasks);

  try {
    transaction.finish();
  } catch (error) {
    debug("Sentry transaction finish error. This does not affect execution.");
    debug(error);
  }

  debug(`Worker thread ${threadId} completed ${workerData.queue} task.`);

  return completedTask;
};

module.exports = runTask;
