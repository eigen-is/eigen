import {useCallback, useEffect, useRef, useState} from 'react';
import * as Y from 'yjs';
import {WebsocketProvider} from 'y-websocket';
import {getCollabWebSocketUrl} from '@workspace/lib/api';

export type SheetData = {
    name: string;
    id?: string;
    order?: number;
    celldata?: CellData[];
    config?: Record<string, any>;
    [key: string]: any;
}

type CellData = {
    r: number;
    c: number;
    v: CellValue | null;
}

type CellValue = {
    v?: string | number;
    m?: string;
    ct?: { fa?: string; t?: string };
    bl?: number;
    it?: number;
    fc?: string;
    bg?: string;
    fs?: number;
    ff?: string;
    un?: number;
    cl?: number;
    ht?: number;
    vt?: number;
    [key: string]: any;
}

const DEFAULT_SHEET: SheetData = {
    name: 'Sheet1',
    id: 'sheet-1',
    order: 0,
    celldata: [],
    config: {},
};

export function useSheet(ownerId: string, mountId: string, pathId: string) {
    const [sheetData, setSheetData] = useState<SheetData[] | null>(null);
    const [synced, setSynced] = useState(false);

    const docRef = useRef<Y.Doc | null>(null);
    const providerRef = useRef<WebsocketProvider | null>(null);
    const undoManagerRef = useRef<Y.UndoManager | null>(null);
    const isLocalChangeRef = useRef(false);

    const initializeDefault = useCallback((doc: Y.Doc) => {
        const sheetsMap = doc.getMap('sheets');
        if (sheetsMap.size > 0) return;
        doc.transact(() => {
            const sheetYMap = new Y.Map();
            for (const [k, v] of Object.entries(DEFAULT_SHEET)) {
                if (k === 'celldata') {
                    sheetYMap.set(k, new Y.Array());
                } else if (typeof v === 'object' && v !== null) {
                    sheetYMap.set(k, JSON.parse(JSON.stringify(v)));
                } else {
                    sheetYMap.set(k, v);
                }
            }
            sheetsMap.set('sheet-1', sheetYMap);

            const orderArray = doc.getArray<string>('sheetOrder');
            orderArray.push(['sheet-1']);
        });
    }, []);

    const readSheetData = useCallback((doc: Y.Doc): SheetData[] => {
        const sheetsMap = doc.getMap('sheets');
        const orderArray = doc.getArray<string>('sheetOrder');
        const order = orderArray.toArray();

        const result: SheetData[] = [];
        for (const sheetId of order) {
            const sheetYMap = sheetsMap.get(sheetId) as Y.Map<any> | undefined;
            if (!sheetYMap) continue;

            const sheet: SheetData = {name: 'Sheet'};
            for (const [k, v] of sheetYMap) {
                if (v instanceof Y.Array) {
                    sheet[k] = v.toJSON();
                } else if (v instanceof Y.Map) {
                    sheet[k] = v.toJSON();
                } else {
                    sheet[k] = v;
                }
            }
            result.push(sheet);
        }

        return result.length > 0 ? result : [DEFAULT_SHEET];
    }, []);

    useEffect(() => {
        const doc = new Y.Doc();
        docRef.current = doc;

        const sheetsMap = doc.getMap('sheets');
        const orderArray = doc.getArray<string>('sheetOrder');

        undoManagerRef.current = new Y.UndoManager([sheetsMap, orderArray]);

        const wsUrl = getCollabWebSocketUrl(ownerId, mountId, pathId);
        const wsProvider = new WebsocketProvider(wsUrl, '', doc, {
            resyncInterval: 5000,
            connect: true,
        });
        providerRef.current = wsProvider;

        const updateReactState = () => {
            if (isLocalChangeRef.current) {
                isLocalChangeRef.current = false;
                return;
            }
            const data = readSheetData(doc);
            setSheetData(data);
        };

        sheetsMap.observeDeep(updateReactState);
        orderArray.observe(updateReactState);

        wsProvider.on('sync', (isSynced: boolean) => {
            if (isSynced) {
                if (sheetsMap.size === 0) {
                    initializeDefault(doc);
                }
                const data = readSheetData(doc);
                setSheetData(data);
                setSynced(true);
            }
        });

        return () => {
            wsProvider.disconnect();
            doc.destroy();
            docRef.current = null;
            providerRef.current = null;
            undoManagerRef.current = null;
        };
    }, [ownerId, mountId, pathId, initializeDefault, readSheetData]);

    const saveSheetData = useCallback((data: SheetData[]) => {
        const doc = docRef.current;
        if (!doc) return;

        isLocalChangeRef.current = true;

        doc.transact(() => {
            const sheetsMap = doc.getMap('sheets');
            const orderArray = doc.getArray<string>('sheetOrder');

            const newIds = new Set(data.map(s => s.id || s.name));
            const existingIds = new Set<string>();
            for (const [key] of sheetsMap) existingIds.add(key);

            for (const id of existingIds) {
                if (!newIds.has(id)) {
                    sheetsMap.delete(id);
                }
            }

            const newOrder: string[] = [];
            for (let i = 0; i < data.length; i++) {
                const sheet = data[i];
                const id = sheet.id || sheet.name;
                newOrder.push(id);

                let sheetYMap = sheetsMap.get(id) as Y.Map<any> | undefined;
                if (!sheetYMap) {
                    sheetYMap = new Y.Map();
                    sheetsMap.set(id, sheetYMap);
                }

                for (const [k, v] of Object.entries(sheet)) {
                    if (k === 'celldata') {
                        let cellArray = sheetYMap.get('celldata') as Y.Array<any> | undefined;
                        if (!cellArray) {
                            cellArray = new Y.Array();
                            sheetYMap.set('celldata', cellArray);
                        }
                        cellArray.delete(0, cellArray.length);
                        if (Array.isArray(v) && v.length > 0) {
                            cellArray.push(v.map((c: any) => JSON.parse(JSON.stringify(c))));
                        }
                    } else if (k === 'config' && typeof v === 'object' && v !== null) {
                        sheetYMap.set('config', JSON.parse(JSON.stringify(v)));
                    } else {
                        sheetYMap.set(k, v);
                    }
                }
            }

            if (orderArray.length > 0) orderArray.delete(0, orderArray.length);
            if (newOrder.length > 0) orderArray.push(newOrder);
        });
    }, []);

    const handleRestore = useCallback((state: Uint8Array) => {
        const doc = docRef.current;
        if (!doc) return;
        Y.applyUpdate(doc, state);
    }, []);

    return {
        sheetData,
        synced,
        saveSheetData,
        handleRestore,
        yjsDoc: docRef.current,
        undoManager: undoManagerRef.current,
    };
}
