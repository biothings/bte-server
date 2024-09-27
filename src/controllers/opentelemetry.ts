import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { Resource } from "@opentelemetry/resources";
import Debug from "debug";
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
const debug = Debug("bte:biothings-explorer:otel-init");
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';


debug("Initializing Opentelemetry instrumentation...");
const sdk = new NodeSDK({
  // metrics, if needed, shall be exported on a different endpoint
  traceExporter: new OTLPTraceExporter({
    url: `${process.env.JAEGER_HOST ?? 'jaeger-otel-collector'}:${process.env.JAEGER_PORT ?? 4318}/v1/traces`
  }),
  instrumentations: [getNodeAutoInstrumentations()],
  resource: new Resource({
    [ATTR_SERVICE_NAME]: "biothings-explorer",
  }),
});
sdk.start();
debug("Opentelemetry instrumentation initialized.");
