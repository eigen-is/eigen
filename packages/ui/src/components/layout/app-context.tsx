import { createContext, useContext } from 'react';

export interface AppContextType {
  appName: string;
  setAppName?: (name: string) => void;
}

export const AppContext = createContext<AppContextType>({
  appName: '',
});

export function useApp() {
  return useContext(AppContext);
}
