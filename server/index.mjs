import { createApp } from './app.mjs';
const port = Number(process.env.PORT || 3001);
createApp().listen(port,'0.0.0.0',()=>console.log(`OnPoint Sky listening on port ${port}`));
