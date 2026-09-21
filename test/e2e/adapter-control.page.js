// The whole page of adapter-control.spec.ts: the browser's own WebGPU and nothing else. Plain JavaScript because the
// project carries no WebGPU typings. Presents a cleared canvas for three seconds, or until the device is lost.
window.control = (async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const started = performance.now();
  let lost = null;
  device.lost.then((info) => {
    lost = { message: info.message || 'device lost', ms: Math.round(performance.now() - started) };
  });
  let rejected = 0;
  device.addEventListener('uncapturederror', (event) => {
    // Kept off the console: the fixture counts console reports as rejected draws, and here they are the measurement.
    event.preventDefault();
    rejected++;
  });
  const context = document.querySelector('canvas').getContext('webgpu');
  context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
  let frames = 0;
  while (performance.now() - started < 3000 && !lost) {
    const encoder = device.createCommandEncoder();
    const view = context.getCurrentTexture().createView();
    encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] }).end();
    device.queue.submit([encoder.finish()]);
    frames++;
    await new Promise((next) => requestAnimationFrame(next));
  }
  return { frames, lost, rejected };
})();
