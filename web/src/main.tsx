import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App.tsx';
import { ConfirmProvider } from './components/Confirm.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReactFlowProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ReactFlowProvider>
  </StrictMode>,
);
