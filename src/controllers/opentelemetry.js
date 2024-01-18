const opentelemetry = require("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { Resource } = require("@opentelemetry/resources");
const { isMainThread } = require("worker_threads");
const Debug = require("debug");
const debug = Debug("bte:biothings-explorer:otel-init");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");

debug("Initializing Opentelemetry instrumentation...");
const sdk = new opentelemetry.NodeSDK({
  traceExporter: new OTLPTraceExporter({
    host: process.env.JAEGER_HOST ?? "jaeger-otel-agent.sri",
    port: parseInt(process.env.JAEGER_PORT ?? "6832"),
  }),
  instrumentations: [getNodeAutoInstrumentations()],
  resource: new Resource({
    "service.name": "biothings-explorer",
  }),
});
sdk.start();
debug("Opentelemetry instrumentation initialized.");
