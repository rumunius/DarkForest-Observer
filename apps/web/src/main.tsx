import { createRoot } from 'react-dom/client';
import { App } from './app';
import { HttpSource } from './data/http';
import './styles.css';

createRoot(document.getElementById('app')!).render(<App source={new HttpSource()} />);
