// The one failure a blob write has left: the transaction carrying it rolls back. The throw goes inside the
// callback, so SQLite really does undo the statements — a throw before it would prove nothing. Returns the undo.
export function breakTransaction(domain: { db: unknown }): () => void {
    const db = domain.db as { transaction: (cb: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    db.transaction = (cb) =>
        original.call(db, (tx: unknown) => {
            cb(tx);
            throw new Error('transaction boom');
        });
    return () => {
        db.transaction = original;
    };
}
