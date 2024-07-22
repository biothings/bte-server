import MetaKG, { SmartAPIKGOperationObject, TestExampleObject } from "@biothings-explorer/smartapi-kg";
import { QEdge2APIEdgeHandler, QEdge } from "@biothings-explorer/query_graph_handler";
import CallAPI from "@biothings-explorer/call-apis";
import { Telemetry, redisClient } from "@biothings-explorer/utils";
import Debug from "debug";
const debug = Debug("bte:biothings-explorer-trapi:cron");
import cron from "node-cron";
import path from "path";
import { stdout } from "process";
import API_LIST from "../../config/api_list";
import axios from "axios";
const smartAPIPath = path.resolve(
  __dirname,
  process.env.STATIC_PATH ? `${process.env.STATIC_PATH}/data/smartapi_specs.json` : "../../../data/smartapi_specs.json",
);
const predicatesPath = path.resolve(
  __dirname,
  process.env.STATIC_PATH ? `${process.env.STATIC_PATH}/data/predicates.json` : "../../../data/predicates.json",
);

class SmartapiSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmartapiSpecError";
  }
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
  return `${op.association.api_name} ${ex.qInput}-${op.association.predicate}-${ex.oneOutput}`;
}

async function runTests(debug = false): Promise<{errors: Error[], opsCount: number }> {
  let errors = [];
  const metakg: MetaKG = global.metakg ? global.metakg : new MetaKG(smartAPIPath, predicatesPath);
  if (!global.metakg) {
    metakg.constructMetaKGSync(true);
  }
  const ops = metakg.ops;

  let found = {};
  let opsCount = 0;
  let errCount = 0;
  for (const op of ops) {
    const includedAPI = API_LIST.include.find(x => x.id === op.association.smartapi.id);
    if (!includedAPI || API_LIST.exclude.find(x => x.id === op.association.smartapi.id)) {
      continue;
    }
    
    // API is unreachable
    if (found[op.association.smartapi.id] === false) {
      continue;
    }

    // check if API is unreachable
    if (!(op.association.smartapi.id in found)) {
      try {
        await axios.get(op.query_operation.server, { validateStatus: () => true, timeout: 5000, maxRedirects: 0 });
        found[op.association.smartapi.id] = true;
      } catch (e) {
        console.log('fun')
        console.log(op.association.api_name)
        console.log(e)
        found[op.association.smartapi.id] = false;
        errors.push(new SmartapiSpecError(`[${includedAPI.name}]: API is unreachable`));
        continue;
      }
    }

    if (op.testExamples && op.testExamples.length > 0) {
      opsCount++;
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
            errors.push(new SmartapiSpecError(`[${generateId(op, example)}]: Record is missing`));
            errCount++;
          }
        } catch (error) {
          if (!error.message) error.message = "Error";
          error.message = `[${generateId(op, example)}]: ${error.message}`;
          errors.push(error);
          errCount++;
        }
      }
      if (debug) stdout.write("\r\r\r\r\r\r\r\r\r\r\r" + opsCount.toString().padStart(4, '0') + " (" + errCount.toString().padStart(4, '0') + ")");
    }
  }
  if (debug) console.log("");

  for (const api of API_LIST.include) {
    if (API_LIST.exclude.find(x => x.id === api.id)) {
      continue;
    }
    if (!(api.id in found)) {
      errors.push(new SmartapiSpecError(`[${api.name}]: API does not have a spec`));
    }
  }

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
        console.log(`Testing SmartAPI specs failed. ${data.errors.length} operations/APIs failed.`);
        data.errors.forEach(err => {
          console.log(`${err.message}${err instanceof SmartapiSpecError ? "" : "\n"+err.stack}`);
        });
      }
      process.exit(0);
    })
    return;
  }

  cron.schedule("* * * * *", async () => {
    debug(`Testing SmartAPI specs now at ${new Date().toUTCString()}!`);
    const span = Telemetry.startSpan({ description: "smartapiTest" });
    try {
      let dbg_namespaces = Debug.disable();
      const results = await runTests(false);
      Debug.enable(dbg_namespaces)
      if (results.errors.length === 0) {
        debug(`Testing SmartAPI specs successful. ${results.opsCount} operations tested.`);
      }
      else {
        debug(`Testing SmartAPI specs failed. ${results.errors.length} operations/APIs failed.`);
        results.errors.forEach(err => {
          debug(`${err.message}${err instanceof SmartapiSpecError ? "" : "\n"+err.stack}`);
          Telemetry.captureException(err);
        });
      }
    } catch (err) {
      debug(`Testing SmartAPI specs failed! The error message is ${err.toString()}`);
      Telemetry.captureException(err);
    }
    span.finish();
  });
}