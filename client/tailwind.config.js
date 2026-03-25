/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Tajawal', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#4c1d95',
          950: '#2e1065',
        },
      },
      boxShadow: {
        soft: '0 2px 15px -3px rgb(0 0 0 / 0.06), 0 10px 20px -4px rgb(0 0 0 / 0.04)',
        glow: '0 0 0 1px rgb(139 92 246 / 0.15), 0 12px 40px -12px rgb(124 58 237 / 0.35)',
        card: '0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px -6px rgb(15 23 42 / 0.08)',
        'inner-light': 'inset 0 1px 0 0 rgb(255 255 255 / 0.06)',
      },
      backgroundImage: {
        'mesh':
          'radial-gradient(at 40% 20%, rgb(139 92 246 / 0.22) 0px, transparent 50%), radial-gradient(at 80% 0%, rgb(59 130 246 / 0.18) 0px, transparent 45%), radial-gradient(at 0% 50%, rgb(244 114 182 / 0.12) 0px, transparent 45%), radial-gradient(at 80% 50%, rgb(34 211 238 / 0.1) 0px, transparent 40%), radial-gradient(at 0% 100%, rgb(167 139 250 / 0.2) 0px, transparent 50%)',
        'sidebar-shine':
          'linear-gradient(165deg, rgb(15 23 42) 0%, rgb(30 27 75) 45%, rgb(15 23 42) 100%)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.45s ease-out forwards',
        shimmer: 'shimmer 2s infinite',
      },
    },
  },
  plugins: [],
};
