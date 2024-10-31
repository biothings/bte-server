import WorkflowError from "./errors/workflow_error";
import { URL } from "url";
import yaml2json from "js-yaml";
import fs from "fs/promises";
import * as lockfile from 'proper-lockfile';
import path from "path";
import { TrapiLog, TrapiSchema, TrapiWorkflow } from "@biothings-explorer/types";
import { NextFunction, Request, Response } from "express";

const schema: unknown[] = [];

export async function getSchema(): Promise<TrapiSchema> {
  if (schema.length !== 0) return schema[0] as TrapiSchema;
  schema.push(
    yaml2json.load(await fs.readFile(path.join(__dirname, "../../docs/smartapi.yaml"), { encoding: "utf8" })),
  );
  //   console.log(schema);
  return schema[0] as TrapiSchema;
}

export function removeQuotesFromQuery(queryString: string) {
  if (queryString.startsWith('"') && queryString.endsWith('"')) {
    return queryString.slice(1, -1);
  } else if (queryString.startsWith("'") && queryString.endsWith("'")) {
    return queryString.slice(1, -1);
  } else {
    return queryString;
  }
}

export function validateWorkflow(workflow: TrapiWorkflow[] | unknown) {
  if (workflow === undefined) {
    return;
  }

  if (!Array.isArray(workflow) || workflow.length !== 1 || !["lookup", "lookup_and_score"].includes(workflow[0].id)) {
    throw new WorkflowError("BTE doesn't handle the operations specified in the workflow field.");
  }
}

export function stringIsAValidUrl(s: string) {
  try {
    new URL(s);
    return true;
  } catch (err) {
    return false;
  }
}

export function filterForLogLevel(logs: TrapiLog[], logLevel: string) {
  const logLevels = {
    ERROR: 3,
    WARNING: 2,
    INFO: 1,
    DEBUG: 0,
  };
  if (logLevel && Object.keys(logLevels).includes(logLevel)) {
    logs = logs.filter(log => {
      return logLevels[log.level] >= logLevels[logLevel];
    });
  }
  return logs;
}

export function methodNotAllowed(_req: Request, res: Response, _next: NextFunction) {
  res.status(405).send();
}

export async function writeFileWithLock(filePath: string, data: string) {
  let release: (() => Promise<void>) | undefined;
  
  try {
    release = await lockfile.lock(filePath, {
      retries: {
        retries: 10,       // number of retry attempts
        factor: 2,         // exponential backoff factor
        minTimeout: 100,   // initial retry delay in milliseconds
        maxTimeout: 1000   // maximum retry delay in milliseconds
      },
      stale: 5000  // lock expiration in milliseconds to prevent deadlocks
    });

    await fs.writeFile(filePath, data);
  } catch (error) {
    // console.error("Failed to write file:", error);
  } finally {
    if (release) {
      await release();
    }
  }
}