import path from "path";
import { TaskInfo } from "@biothings-explorer/types";
import handler from "../../controllers/meta_knowledge_graph";
import * as utils from "../../utils/common";
import { runTask, taskResponse, taskError } from "../../controllers/threading/threadHandler";
import { Express, NextFunction, Request, Response, RequestHandler } from "express";

class MetaKG {
  setRoutes(app: Express) {
    app
      .route("/v1/meta_knowledge_graph")
      .get((async (_req: Request, res: Response, next: NextFunction) => {
        try {
          const response = await runTask(_req, res, path.parse(__filename).name);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(response));
        } catch (error) {
          next(error);
        }
      }) as RequestHandler)
      .all(utils.methodNotAllowed);
  }

  async task(taskInfo: TaskInfo) {
    try {
      let kg = undefined;

      // read metakg from files if not globally defined
      if(!taskInfo.data.options.metakg) {
        const metaKGHandler = new handler(undefined);
        kg = await metaKGHandler.getKG(); 
      } else {
        kg = taskInfo.data.options.metakg;
      }
      // response.logs = utils.filterForLogLevel(response.logs, options.logLevel);
      return taskResponse(kg);
    } catch (error) {
      taskError(error as Error);
    }
  }
}

export default new MetaKG();
