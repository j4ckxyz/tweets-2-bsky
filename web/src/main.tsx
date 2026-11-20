import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import '@fontsource-variable/onest';
import './index.css';
import { setupBrowserDebugLogging } from './lib/debug-logger';
import { queryClient } from './lib/query-client';

setupBrowserDebugLogging();

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </QueryClientProvider>,
);
