const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const DIST_DIR = path.join(__dirname, 'dist');

// 1. 严格的核心 JS 白名单
const ALLOWED_JS = [
  'background.js',
  'content.js',
  'popup.js',
  'auth-relay.js'
];

// 2. 严格的静态资源白名单（只允许扩展真正需要的 HTML 和图标，屏蔽所有网站页面和杂图）
const ALLOWED_ASSETS = [
  'popup.html',
  'icon16.png',
  'icon32.png',
  'icon48.png',
  'icon128.png',
  'icon300.png' // 商店可能需要的大图
];

// 3. 必须包含的配置文件
const ALLOWED_CONFIGS = ['manifest.json'];

// 确保 dist 目录存在，如果存在则先清空
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

const files = fs.readdirSync(__dirname);

async function build() {
  console.log('🛡️ 开始【终极严格安全模式】构建扩展...\n');

  for (const file of files) {
    const filePath = path.join(__dirname, file);
    const stat = fs.statSync(filePath);

    if (!stat.isFile()) continue;

    const destPath = path.join(DIST_DIR, file);

    // 规则 A: 核心 JS 文件
    if (ALLOWED_JS.includes(file)) {
      console.log(`✅ [压缩] 核心代码: ${file}`);
      const code = fs.readFileSync(filePath, 'utf8');
      try {
        const minified = await minify(code, {
          compress: {
            drop_console: true, // 移除 console.log
            drop_debugger: true
          },
          mangle: true,
          format: { comments: false }
        });
        fs.writeFileSync(destPath, minified.code, 'utf8');
      } catch (err) {
        console.error(`❌ 压缩 ${file} 失败:`, err);
      }
    }
    // 规则 B: 扩展必需的静态资源
    else if (ALLOWED_ASSETS.includes(file)) {
      console.log(`✅ [复制] 扩展资源: ${file}`);
      fs.copyFileSync(filePath, destPath);
    }
    // 规则 C: 配置文件
    else if (ALLOWED_CONFIGS.includes(file)) {
      console.log(`✅ [复制] 配置文件: ${file}`);
      fs.copyFileSync(filePath, destPath);
    }
    // 🛡️ 拦截所有其他文件（包括 admin.html, index.html, qrcode.jpg 等）
    else {
      console.log(`🚫 [拦截] 忽略非扩展文件: ${file}`);
    }
  }

  console.log('\n🎉 构建完成！已严格过滤所有非插件文件，代码已安全输出到 dist 目录。');
}

build();
