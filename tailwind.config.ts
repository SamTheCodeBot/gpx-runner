import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Apex Run — Material Design 3 light palette
        primary:            { DEFAULT: "#1565C0", container: "#d3e4ff" },
        "on-primary":       { DEFAULT: "#ffffff" },
        "on-primary-container": { DEFAULT: "#001b44" },
        secondary:          { DEFAULT: "#5c6bc0", container: "#e0e3ff" },
        "on-secondary":     { DEFAULT: "#ffffff" },
        "on-secondary-container": { DEFAULT: "#101949" },
        tertiary:            { DEFAULT: "#7c5800", container: "#ffdfa6" },
        "on-tertiary":       { DEFAULT: "#ffffff" },
        "on-tertiary-container": { DEFAULT: "#271900" },
        error:              { DEFAULT: "#ba1a1a", container: "#ffdad6" },
        "on-error":          { DEFAULT: "#ffffff" },
        "on-error-container":{ DEFAULT: "#410002" },
        background:          { DEFAULT: "#fbf9f8" },
        "on-background":     { DEFAULT: "#1a1c1e" },
        "surface-dim":       { DEFAULT: "#d0d7e0" },
        "surface-container": { DEFAULT: "#efeded" },
        "surface-container-low":  { DEFAULT: "#f4f3f3" },
        "surface-container-lowest": { DEFAULT: "#fbf9f8" },
        "surface-container-high": { DEFAULT: "#e3e2e2" },
        "surface-container-highest": { DEFAULT: "#dcdbdb" },
        "on-surface":        { DEFAULT: "#1a1c1e" },
        "on-surface-variant":{ DEFAULT: "#42474e" },
        outline:            { DEFAULT: "#72787f" },
        "outline-variant":   { DEFAULT: "#c3c7cf" },
      },
      fontFamily: {
        display: ["Manrope", "sans-serif"],
        body:    ["Inter", "sans-serif"],
        headline: ["Manrope", "sans-serif"],
      },
      borderRadius: {
        sm:  "4px",
        md:  "8px",
        lg:  "12px",
        xl:  "16px",
        "2xl": "24px",
        full: "9999px",
      },
    },
  },
  plugins: [],
};
export default config;
