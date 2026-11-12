module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    {
      visitor: {
        ImportDeclaration(path) {
          // 6-14(a): JSX 探针仅在 LX_JSX_PROBE=1 时启用（ios-runtime-debug.yml 设置该变量，
          // 保持其 ###UNDEFINED_ELEMENT### 检测可用）；默认关闭，Release 不再全量加 null 检查。
          if (process.env.LX_JSX_PROBE !== '1') return
          if (
            path.node.source.value === 'react/jsx-runtime' &&
            !(path.hub.file.opts.filename || '').endsWith('jsxRuntimeProbe.ts')
          ) {
            path.node.source.value = '@/utils/jsxRuntimeProbe'
          }
        },
      },
    },
    '@babel/plugin-proposal-export-namespace-from',
    [
      'module-resolver',
      {
        root: ['.'],
        extensions: [
          '.android.ts',
          '.ios.ts',
          '.android.tsx',
          '.ios.tsx',
          '.tsx',
          '.ts',
          '.android.js',
          '.ios.js',
          '.android.jsx',
          '.ios.jsx',
          '.jsx',
          '.js',
          '.json',
        ],
        alias: {
          '@': './src',
          // '@config': './src/config',
          // '@store': './src/store',
          // '@components': './src/components',
          // '@navigation': './src/navigation',
          // '@screens': './src/screens',
          // '@theme': './src/theme',
        },
      },
    ],
  ],
}
