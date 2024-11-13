import handler from "../../controllers/meta_knowledge_graph";
import * as utils from "../../utils/common";
import path from "path";
import { TaskInfo } from "@biothings-explorer/types";
import { runTask, taskResponse, taskError } from "../../controllers/threading/threadHandler";
import { Express, NextFunction, Request, Response, RequestHandler } from "express";

import MetaKnowledgeGraph from "@biothings-explorer/smartapi-kg";

class MetaKGByAPI {
  setRoutes(app: Express) {
    app
      .route("/v1/smartapi/:smartAPIID/meta_knowledge_graph")
      .get((async (req: Request, res: Response, next: NextFunction) => {
        try {
          const response = await runTask(req, res, path.parse(__filename).name);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(response));
        } catch (error) {
          next(error);
        }
      })as RequestHandler)
      .all(utils.methodNotAllowed);
  }

  async task(taskInfo: TaskInfo) {
    try {
      const metaKGHandler = new handler(taskInfo.data.smartAPIID, undefined);
      let metakg = undefined;
      // initialize MetaKG only if ops are provided because handler logic is built upon that
      if (taskInfo.data.options.metakg !== undefined)
        metakg = new MetaKnowledgeGraph(undefined, undefined, taskInfo.data.options.metakg);
      const kg = await metaKGHandler.getKG(metakg);
      // response.logs = utils.filterForLogLevel(response.logs, options.logLevel);
      return taskResponse(kg);
    } catch (error) {
      taskError(error as Error);
    }
  }
}

export default new MetaKGByAPI();
