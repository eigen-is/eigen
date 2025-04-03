import {Label} from "@apps/api-server/types/label";

export interface LabelFilterHeaderProps {
    labels: Label[];
    labelId: string;
}

export function LabelFilterHeader({
                                      labels,
                                      labelId,
                                  }: LabelFilterHeaderProps) {

    const label = labels.find(l => l.id === labelId);

    return label ? <div className="h-12 px-4 flex items-center border-b">
        <h1 className="text-base font-medium flex items-center gap-2">
              <span
                  className="h-3 w-3 rounded-full"
                  style={{backgroundColor: label.color}}
              />
            {label.name}
            <span/>
        </h1>
    </div> : null;
}