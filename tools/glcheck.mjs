import { chromium } from 'playwright-core';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox','--no-sandbox'] });
const p = await b.newPage();
await p.setContent('<canvas id=c width=64 height=64></canvas>');
const info = await p.evaluate(() => {
  const c = document.getElementById('c');
  const gl = c.getContext('webgl2');
  if (!gl) return { webgl2: false };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    webgl2: true,
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
    version: gl.getParameter(gl.VERSION),
  };
});
console.log(JSON.stringify(info, null, 2));
await b.close();
