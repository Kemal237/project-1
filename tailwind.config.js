module.exports = {
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          primary:   '#0d1117',
          secondary: '#161b22',
          card:      '#1c2128',
          hover:     '#21262d',
        },
        border: {
          DEFAULT: '#30363d',
          light:   '#3d444d',
        },
        accent: {
          blue:   '#1f6feb',
          green:  '#238636',
          red:    '#da3633',
          yellow: '#9e6a03',
        },
        text: {
          primary:   '#e6edf3',
          secondary: '#7d8590',
          muted:     '#484f58',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
