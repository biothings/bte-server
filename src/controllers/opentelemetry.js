const opentelemetry = require("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-proto");
const { PeriodicExportingMetricReader, ConsoleMetricExporter } = require("@opentelemetry/sdk-metrics");
const { Resource } = require("@opentelemetry/resources");
const { ConsoleSpanExporter } = require("@opentelemetry/sdk-trace-node");
const Debug = require("debug");
const debug = Debug("bte:biothings-explorer:otel-init");

debug("Initializing Opentelemetry instrumentation...");
const sdk = new opentelemetry.NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: (process.env.JAEGER_URL ?? "http://localhost:4318") + "/v1/traces",
  }),
  instrumentations: [getNodeAutoInstrumentations()],
  resource: new Resource({
    "service.name": "biothings-explorer",
  }),
});
sdk.start();
debug("Opentelemetry instrumentation initialized.");
