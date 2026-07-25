// 共享的 OpenAI 客户端(懒加载单例),供 agentCore 与各工具复用。
import OpenAI from 'openai';
import { config } from '../config.js';

let client = null;

export function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: config.openai.apiKey,
      baseURL: config.openai.baseURL, // 未配置则 undefined,用官方默认
    });
  }
  return client;
}

export default getClient;
