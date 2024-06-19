import MetaKG, { SmartAPIKGOperationObject, TestExampleObject } from "@biothings-explorer/smartapi-kg";
import { QEdge2APIEdgeHandler, QEdge } from "@biothings-explorer/query_graph_handler";
import CallAPI from "@biothings-explorer/call-apis";
import { Telemetry, redisClient } from "@biothings-explorer/utils";
import Debug from "debug";
const debug = Debug("bte:biothings-explorer-trapi:cron");
import cron from "node-cron";
import path from "path";
import { stdout } from "process";
import { spanStatusfromHttpCode } from "@sentry/node";
const smartAPIPath = path.resolve(
  __dirname,
  process.env.STATIC_PATH ? `${process.env.STATIC_PATH}/data/smartapi_specs.json` : "../../../data/smartapi_specs.json",
);
const predicatesPath = path.resolve(
  __dirname,
  process.env.STATIC_PATH ? `${process.env.STATIC_PATH}/data/predicates.json` : "../../../data/predicates.json",
);

interface OpError {
  op: string;
  issue: Error;
}

function generateEdge(op: SmartAPIKGOperationObject, ex: TestExampleObject) {
  return {
    subject: {
      categories: [op.association.input_type],
      ids: [ex.qInput],
      id: "n0"
    },
    object: {
      categories: [op.association.output_type],
      ids: [ex.oneOutput],
      id: "n1"
    },
    predicates: ["biolink:" + op.association.predicate],
    id: "e01",
    frozen: true,
  };
}

function generateId(op: SmartAPIKGOperationObject, ex: TestExampleObject) {
  return `${op.association.api_name} [${ex.qInput}-${op.association.predicate}-${ex.oneOutput}]`;
}

async function runTests(debug = false): Promise<{errors: OpError[], opsCount: number }> {
  let errors = [];
  let opsCount = 0;
  const metakg: MetaKG = global.metakg ? global.metakg : new MetaKG(smartAPIPath, predicatesPath);
  if (!global.metakg) {
    metakg.constructMetaKGSync(false);
  }
  const ops = metakg.ops;
  for (const op of ops) { 
    if (op.testExamples && op.testExamples.length > 0) {
      opsCount++;
    }
  }
  if (debug) console.log(`Operation Count: ${opsCount}`);
  let curCount = 0;
  let errCount = 0;
  for (const op of ops) {
    if (op.testExamples && op.testExamples.length > 0) {
      curCount++;
      for (const example of op.testExamples) {
        try {
          const newMeta = new MetaKG(undefined, undefined, [op]);
          const edge = new QEdge(generateEdge(op, example));
          edge.subject.setEquivalentIDs({ [example.qInput]: { primaryID: example.qInput, equivalentIDs: [example.qInput], label: example.qInput, labelAliases: [], primaryTypes: [op.association.input_type], semanticTypes: [op.association.input_type] }})
          const edgeConverter = new QEdge2APIEdgeHandler([edge], newMeta);
          const APIEdges = await edgeConverter.convert([edge]);
          const executor = new CallAPI(APIEdges, {}, redisClient);
          const records = await executor.query(false, {});
          if (records.filter(r => r.object.original === example.oneOutput).length <= 0) {
            errors.push({ op: generateId(op, example), issue: new Error("Record is missing") });
            errCount++;
          }
        } catch (error) {
          errors.push({ op: generateId(op, example), issue: error });
          errCount++;
        }
      }
      if (debug) stdout.write("\r\r\r\r\r\r\r\r\r\r\r" + curCount.toString().padStart(4, '0') + " (" + errCount.toString().padStart(4, '0') + ")");
    }
  }
  if (debug) console.log("");

  return { errors, opsCount }
}

export default function testSmartApi() {
  // Env set in manual sync script
  const sync_and_exit = process.env.SYNC_AND_EXIT === "true";
  if (sync_and_exit) {
    console.log("Testing SmartAPI specs with subsequent exit...");
    runTests(true).then(data => {
      if (data.errors.length === 0) {
        console.log(`Testing SmartAPI specs successful. ${data.opsCount} operations tested.`);
      }
      else {
        console.log(`Testing SmartAPI specs failed. ${data.errors.length} operations failed.`);
        data.errors.forEach(err => {
          console.log(`${err.op}: ${err.issue.message}${err.issue.message = "Record is missing" ? "" : "\n"+err.issue.stack}`);
        });
      }
      process.exit(0);
    })
    return;
  }

  cron.schedule("0 0 * * *", async () => {
    debug(`Testing SmartAPI specs now at ${new Date().toUTCString()}!`);
    const span = Telemetry.startSpan({ description: "smartapiTest" });
    try {
      const results = await runTests(false);
      if (results.errors.length === 0) {
        debug(`Testing SmartAPI specs successful. ${results.opsCount} operations tested.`);
      }
      else {
        debug(`Testing SmartAPI specs failed. ${results.errors.length} operations failed (${results.opsCount} tested).`);
        results.errors.forEach(err => {
          debug(`${err.op}: ${err.issue.message}${err.issue.message = "Record is missing" ? "" : "\n"+err.issue.stack}`);
          Telemetry.captureException(err.issue);
        });
      }
    } catch (err) {
      debug(`Testing SmartAPI specs failed! The error message is ${err.toString()}`);
    }
    span.finish();
  });
}