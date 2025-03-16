export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface LabelManagerProps {
  // Data props
  labels: Label[];
  
  // Callback functions for label operations
  onAddLabel: (label: Omit<Label, 'id'>) => void;
  onEditLabel: (label: Label) => void;
  onDeleteLabel: (labelId: string) => void;
  
  // Optional path generation function for labels - apps can specify their own routing
  getLabelPath?: (label: Label) => string;
  
  // Optional className for customizing appearance
  className?: string;
}
