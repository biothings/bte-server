const opentelemetry = require("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { Resource } = require("@opentelemetry/resources");
const Debug = require("debug");
const debug = Debug("bte:biothings-explorer:otel-init");
const { JaegerExporter } = require("@opentelemetry/exporter-jaeger");

debug("Initializing Opentelemetry instrumentation...");
const sdk = new opentelemetry.NodeSDK({
  traceExporter: new JaegerExporter({
    host: process.env.JAEGER_HOST ?? "jaeger-otel-agent.sri",
    port: parseInt(process.env.JAEGER_PORT ?? "6381"),
  }),
  instrumentations: [getNodeAutoInstrumentations()],
  resource: new Resource({
    "service.name": "biothings-explorer",
  }),
});
sdk.start();
debug("Opentelemetry instrumentation initialized.");
