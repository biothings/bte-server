const { isMainThread, threadId } = require("worker_threads");
const debug = require("debug")(`bte:biothings-explorer-trapi:worker${threadId}`);

if (!isMainThread) {
  // Log thread start before BioLink model loads
  debug(`Worker thread ${threadId} is ready to accept tasks.`);
}

const { tasks } = require("../../routes/index");
const { getQueryQueue } = require("../async/asyncquery_queue");
const Sentry = require("@sentry/node");
const { ProfilingIntegration } = require("@sentry/profiling-node");

// use SENTRY_DSN environment variable
Sentry.init({
  // dsn: "https://5297933ef0f6487c9fd66532bb1fcefe@o4505444772806656.ingest.sentry.io/4505449737420800",
  integrations: [
    // Automatically instrument Node.js libraries and frameworks
    ...Sentry.autoDiscoverNodePerformanceMonitoringIntegrations(),
    new ProfilingIntegration(),
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

const runTask = async ({ req, route, port, job: { jobId, queueName } = {} }) => {
  debug(`Worker thread ${threadId} beginning task.`);

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

  const transaction = Sentry.startTransaction({ name: route });
  transaction.setData("request", req.data.queryGraph);
  Sentry.getCurrentHub().configureScope(scope => {
    scope.clearBreadcrumbs();
    scope.setSpan(transaction);
  });

  const completedTask = await tasks[route](req);
  await Promise.all(global.cachingTasks);

  transaction.finish();

  debug(`Worker thread ${threadId} completed task.`);

  return completedTask;
};

module.exports = runTask;
