import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import Debug from "debug";
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
const debug = Debug("bte:biothings-explorer:otel-init");
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const jaegerHost = process.env.JAEGER_HOST ?? 'jaeger-otel-collector.sri';
const jaegerPort = process.env.JAEGER_PORT ?? 4318;
const jaegerResName = process.env.JAEGER_RES_NAME ?? '/v1/traces';
const traceExporter = new OTLPTraceExporter({
  url: `http://${jaegerHost}:${jaegerPort}${jaegerResName}`
});

debug("Initializing Opentelemetry instrumentation...");
const sdk = new NodeSDK({
  // metrics, if needed, shall be exported on a different endpoint
  // trace a subset of instrumentations to avoid performance overhead
  instrumentations: [new HttpInstrumentation()],
  resource: new Resource({
    [ATTR_SERVICE_NAME]: "biothings-explorer",
  }),
  // use simple span processor to avoid losing data when the forked process exits (taskHandler)
  // @ts-ignore - fix from MetinSeylan/Nestjs-OpenTelemetry#63
  spanProcessors: [new SimpleSpanProcessor(traceExporter)],
});
debug(`OTel URL http://${jaegerHost}:${jaegerPort}${jaegerResName}`);
sdk.start();
debug("Opentelemetry instrumentation initialized.");
