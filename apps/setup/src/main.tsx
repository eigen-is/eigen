import ReactDOM from 'react-dom/client';
import { SetupWizard } from './components/setup-wizard';

import '@workspace/ui/globals.css';

function App() {
    return <SetupWizard />;
}

const rootElement = document.getElementById('app')!;

if (!rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(<App />);
}
