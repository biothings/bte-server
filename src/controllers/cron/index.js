const smartapiCron = require("./update_local_smartapi");
const cacheClearCron = require("./clear_edge_cache");

module.exports = () => {
  smartapiCron();
  cacheClearCron();
};
