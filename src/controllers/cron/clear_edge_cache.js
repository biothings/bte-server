const { redisClient } = require("@biothings-explorer/query_graph_handler");
const Debug = require("debug");
const cron = require("node-cron");
const debug = Debug("bte:biothings-explorer-trapi:cron");

module.exports = () => {
  cron.schedule("0 0 * * *", async () => {
    debug("Checking status for edge cache clearing.");
    if (!redisClient.clientEnabled) {
      debug("Cache not enabled, skipping edge cache clearing");
      return;
    }
    debug("Redis client enabled, proceeding with cache clearing.");
    await redisClient.client.usingLock(["redisLock:EdgeCaching"], 600000, () => {
      redisClient.client.clearEdgeCache();
    });
  });
};
