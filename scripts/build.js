const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

async function build() {
    const isWatch = process.argv.includes('--watch');
    const isProduction = process.argv.includes('--production');

    // 读取 Sentry DSN（从环境变量或 .env.local 文件）
    let sentryDsn = process.env.SENTRY_DSN || '';
    const envLocalPath = path.join(__dirname, '../.env.local');
    if (!sentryDsn && fs.existsSync(envLocalPath)) {
        const envContent = fs.readFileSync(envLocalPath, 'utf-8');
        const match = envContent.match(/SENTRY_DSN=(.+)/);
        if (match) {
            sentryDsn = match[1].trim();
        }
    }
    
    if (isProduction && !sentryDsn) {
        console.warn('Warning: SENTRY_DSN not set. Error reporting will be disabled.');
    }

    // 1. Bundle Extension Code
    const extensionContext = await esbuild.context({
        entryPoints: ['./src/extension.ts'],
        bundle: true,
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        outfile: './out/extension.js',
        sourcemap: !isProduction,
        minify: isProduction,
        define: {
            'process.env.SENTRY_DSN': JSON.stringify(sentryDsn),
        },
    });

    // 2. Bundle Webview JS
    const webviewContext = await esbuild.context({
        entryPoints: ['./src/view/webview/dashboard.js'],
        bundle: true,
        outfile: './out/view/webview/dashboard.js',
        minify: isProduction,
        sourcemap: !isProduction,
        target: 'es2020',
        format: 'iife',
    });

    if (isWatch) {
        await Promise.all([
            extensionContext.watch(),
            webviewContext.watch()
        ]);
        console.log('Watching for changes...');
    } else {
        await Promise.all([
            extensionContext.rebuild(),
            webviewContext.rebuild()
        ]);
        await extensionContext.dispose();
        await webviewContext.dispose();
        console.log('Build finished successfully.');
    }

    // 3. Simple copy for CSS (or you could use an esbuild plugin if needed)
    const webviewDir = path.join(__dirname, '../out/view/webview');
    if (!fs.existsSync(webviewDir)) {
        fs.mkdirSync(webviewDir, { recursive: true });
    }
    fs.copyFileSync('./src/view/webview/dashboard.css', './out/view/webview/dashboard.css');
    fs.copyFileSync('./src/view/webview/list_view.css', './out/view/webview/list_view.css');
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});
