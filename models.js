// 模型配置中心：新增模型时在这里加一项，并在 manifest.json 的
// host_permissions 和 content_scripts.matches 中补充对应域名即可。
const MODELS = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    // 打开裸域名即新对话
    url: 'https://chatgpt.com/',
    host: 'chatgpt.com',
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    host: 'chat.deepseek.com',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    host: 'gemini.google.com',
  },
  doubao: {
    id: 'doubao',
    name: '豆包',
    url: 'https://www.doubao.com/chat/',
    host: 'www.doubao.com',
  },
};

if (typeof module !== 'undefined') {
  module.exports = MODELS;
}
