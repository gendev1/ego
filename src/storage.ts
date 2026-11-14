// Where ego keeps its state, chosen by EGO_STORAGE:
//
//   memory     nothing kept (tests)
//   sqlite     one file, EGO_DB (default state/ego.db): one process, a volume and Litestream on k8s
//   cockroach  one schema EGO_SCHEMA (default ego_0) in COCKROACH_URL, owned by this process through a lease:
//              pods keep nothing themselves; a pod that loses the lease must stop, and `onLost` says so.
//              Needs the optional dependency pi-durable-cockroach, loaded only for this kind.
import { hostname } from "node:os";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export type StorageKind = "memory" | "sqlite" | "cockroach";

export interface StorageSettings {
    readonly kind: StorageKind;
    readonly sqlitePath?: string;
    readonly cockroachUrl?: string;
    readonly schema?: string;
    /** Who holds the CockroachDB lease: the pod's name. */
    readonly owner?: string;
    readonly onLost?: (error: Error) => void;
}

/** The settings of the environment: EGO_STORAGE, EGO_DB, COCKROACH_URL, EGO_SCHEMA, POD_NAME. */
export const storageSettings = (env: NodeJS.ProcessEnv = process.env): StorageSettings => {
    const kind = env.EGO_STORAGE ?? "sqlite";
    if (kind !== "memory" && kind !== "sqlite" && kind !== "cockroach") {
        throw new Error(`EGO_STORAGE must be memory, sqlite or cockroach, not ${kind}`);
    }
    return {
        kind,
        sqlitePath: env.EGO_DB ?? "state/ego.db",
        ...(env.COCKROACH_URL === undefined ? {} : { cockroachUrl: env.COCKROACH_URL }),
        schema: env.EGO_SCHEMA ?? "ego_0",
        owner: env.POD_NAME ?? env.HOSTNAME ?? hostname(),
    };
};

/** What ego uses of the optional package; typed here so ego typechecks without it installed. */
interface CockroachPackage {
    openCockroachStorage(options: {
        connection: string;
        schema: string;
        owner: string;
        onLost?: (error: Error) => void;
    }): Promise<{ storage: Storage }>;
}

/** The name through a variable: TypeScript then does not need the package to be installed. */
const COCKROACH_PACKAGE: string = "pi-durable-cockroach";

/** The optional CockroachDB storage package, or an error that says how to get it. */
const loadCockroach = async (): Promise<CockroachPackage> => {
    try {
        return (await import(COCKROACH_PACKAGE)) as CockroachPackage;
    } catch (error) {
        throw new Error("EGO_STORAGE=cockroach needs the optional dependency pi-durable-cockroach, which is not installed", {
            cause: error,
        });
    }
};

export const openStorage = async (settings: StorageSettings): Promise<Storage> => {
    switch (settings.kind) {
        case "memory":
            return new MemoryStorage();
        case "sqlite":
            return openNodeSqliteStorage(settings.sqlitePath ?? "state/ego.db");
        case "cockroach": {
            if (settings.cockroachUrl === undefined) throw new Error("EGO_STORAGE=cockroach needs COCKROACH_URL");
            const { openCockroachStorage } = await loadCockroach();
            const { storage } = await openCockroachStorage({
                connection: settings.cockroachUrl,
                schema: settings.schema ?? "ego_0",
                owner: settings.owner ?? hostname(),
                ...(settings.onLost === undefined ? {} : { onLost: settings.onLost }),
            });
            return storage;
        }
    }
};
