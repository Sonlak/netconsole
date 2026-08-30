import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { unstableSetRender } from 'antd';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/inter/wght.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles/index.css';
import 'antd/dist/reset.css';
import './styles/antd-bridge.css';
import { ThemeProvider } from './components/theme-provider';
import { SiteProvider } from './components/site-provider';
import App from './App';

// antd 5 static Modal.confirm / message render into a DocumentFragment.
// React 19 createRoot() only accepts an Element, so those APIs were silent no-ops.
const antdRoots = new WeakMap<object, { root: Root; mount: HTMLDivElement }>();

unstableSetRender((node, container) => {
  const key = container as object;
  let entry = antdRoots.get(key);
  if (!entry) {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    entry = { root: createRoot(mount), mount };
    antdRoots.set(key, entry);
  }
  entry.root.render(node);
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    entry.root.unmount();
    entry.mount.remove();
    antdRoots.delete(key);
  };
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <SiteProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SiteProvider>
    </ThemeProvider>
  </StrictMode>,
);
