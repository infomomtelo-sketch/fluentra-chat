import { onRequestPost as __api_video_chat_js_onRequestPost } from "/home/user/fluentra-chat/functions/api/video-chat.js"
import { onRequest as __api_video_chat_js_onRequest } from "/home/user/fluentra-chat/functions/api/video-chat.js"

export const routes = [
    {
      routePath: "/api/video-chat",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_video_chat_js_onRequestPost],
    },
  {
      routePath: "/api/video-chat",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api_video_chat_js_onRequest],
    },
  ]