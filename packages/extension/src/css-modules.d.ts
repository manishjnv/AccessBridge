/** Global type declaration for CSS module imports (*.module.css). */
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
