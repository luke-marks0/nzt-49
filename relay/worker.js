import {handleRequest} from "./handler.js";

export default {
  fetch(request,env) {
    return handleRequest(request,{allowedOrigins:env.ALLOWED_ORIGINS});
  },
};
