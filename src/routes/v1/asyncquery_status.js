const path = require("path");
const { redisClient } = require("@biothings-explorer/query_graph_handler");
const { getQueryQueue } = require("../../controllers/async/asyncquery_queue");
const { getQueryResponse } = require("../../controllers/async/asyncquery");
const lz4 = require("lz4");
const utils = require("../../utils/common");

let queryQueue;

const swaggerValidation = require("../../middlewares/validate");
const { runTask, taskResponse, taskError } = require("../../controllers/threading/threadHandler");
const debug = require("debug")("bte:biothings-explorer-trapi:async");

class VCheckQueryStatus {
  setRoutes(app) {
    app
      .route(["/v1/asyncquery_status/:id", "/v1/asyncquery_response/:id"])
      .get(swaggerValidation.validate, async (req, res, next) => {
        try {
          const response = await runTask(req, this.task, path.parse(__filename).name, res, false);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(response));
        } catch (err) {
          next(err);
        }
      })
      .all(utils.methodNotAllowed);
  }

  async task(req) {
    //logger.info("query /query endpoint")
    try {
      debug(`checking query status of job ${req.params.id}`);
      let jobID = req.params.id;
      let queryQueue;
      if (!redisClient.clientEnabled) {
        taskResponse({ error: "Redis service is unavailable" }, 503);
      }

      if (jobID.startsWith("BT_")) {
        queryQueue = getQueryQueue("bte_query_queue_by_team");
      } else if (jobID.startsWith("BA_")) {
        queryQueue = getQueryQueue("bte_query_queue_by_api");
      } else {
        queryQueue = getQueryQueue("bte_query_queue");
      }

      let job = await queryQueue.getJobFromId(jobID);
      if (job === null) {
        return taskResponse(null, 404);
      }

      await queryQueue.isReady();

      const state = await job.getState();
      let progress = job._progress;

      let logs = await queryQueue.getJobLogs(jobID);
      logs = logs.logs.map(log => JSON.parse(log));
      const originalLogLevel = JSON.parse(await redisClient.client.getTimeout(`asyncQueryResult:logLevel:${jobID}`));
      logs = utils.filterForLogLevel(logs, req.data.options.log_level ?? originalLogLevel);

      // convert to TRAPI states
      let [status, description] = {
        completed: ["Completed", "The query has finished executing."],
        failed: ["Failed", job.failedReason],
        delayed: ["Queued", "The query is queued, but has been delayed."],
        active: ["Running", "The query is currently being processed."],
        waiting: ["Queued", "The query is waiting in the queue."],
        paused: ["Queued", "The query is queued, but the queue is temporarily paused."],
        stuck: ["Failed", "The query is stuck (if you see this, raise an issue)."],
        null: ["Failed", "The query status is unknown, presumed failed (if you see this, raise an issue)."],
      }[state];

      if (status === "Failed" && !req.endpoint.includes("asyncquery_response")) {
        if (description.includes("Promise timed out")) {
          // something might break when calculating process.env.JOB_TIMEOUT so wrap it in try catch
          try {
            return taskResponse({
              job_id: jobID,
              status,
              description: `Job was stopped after exceeding time limit of ${
                parseInt(process.env.JOB_TIMEOUT ?? (1000 * 60 * 5).toString()) / 1000
              }s`,
              logs,
            });
          } catch (e) {
            return taskResponse({ job_id: jobID, status, description, logs });
          }
        }
        return taskResponse({ job_id: jobID, status, description, logs });
      }

      // If done, just give response if using asyncquery_response
      if ((state === "completed" || state === "failed") && req.endpoint.includes("asyncquery_response")) {
        let returnValue;
        const storedResponse = await getQueryResponse(jobID, req.data.options.log_level);

        if (storedResponse && !storedResponse.logs && logs) {
          storedResponse.logs = logs;
        }

        returnValue = storedResponse ? storedResponse : { error: "Response expired. Responses are kept 30 days." };
        return taskResponse(returnValue, returnValue.statusCode || 200);
      }

      // Otherwise respond for asyncquery_status
      taskResponse({ job_id: jobID, status, progress, description, response_url: job.data.url, logs }, 200);
    } catch (error) {
      taskError(error);
    }
  }
}

module.exports = new VCheckQueryStatus();
