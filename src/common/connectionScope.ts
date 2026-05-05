"use strict";

import { ModelType } from "./constants";
import { Node } from "../model/interface/node";

/**
 * Non-empty list = restrict visible databases/schemas to these names (case-insensitive).
 * Combines the connection "Databases" field (`database`) and "Include Databases" (`includeDatabases`).
 */
export function getConnectionDatabaseAllowlist(node: Node): string[] | null {
    const raw: string[] = [];
    if (node.includeDatabases) {
        raw.push(...node.includeDatabases.split(",").map((s) => s.trim()).filter(Boolean));
    }
    if (node.database) {
        const d = String(node.database).trim();
        if (d) {
            raw.push(d);
        }
    }
    if (raw.length === 0) {
        return null;
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of raw) {
        const k = p.toLowerCase();
        if (!seen.has(k)) {
            seen.add(k);
            out.push(p);
        }
    }
    return out;
}

export function getDatabaseNameFromShowRow(db: any): string {
    if (!db) {
        return "";
    }
    const v = db.schema ?? db.Database ?? db.database ?? db.name;
    return v != null ? String(v) : "";
}

export function rowMatchesDatabaseAllowlist(db: any, allowlist: string[] | null): boolean {
    if (!allowlist) {
        return true;
    }
    const name = getDatabaseNameFromShowRow(db).toLowerCase().trim();
    if (!name) {
        return false;
    }
    return allowlist.some((a) => a.toLowerCase().trim() === name);
}

export function treeDbNodeMatchesAllowlist(node: Node, allowlist: string[] | null): boolean {
    if (!allowlist) {
        return true;
    }
    if (node.contextValue === ModelType.SCHEMA) {
        const parts = [node.schema, node.database].filter(Boolean) as string[];
        const allowLower = allowlist.map((a) => a.toLowerCase().trim());
        return parts.some((p) => allowLower.includes(p.toLowerCase().trim()));
    }
    if (node.contextValue === ModelType.CATALOG) {
        const parts = [node.database].filter(Boolean) as string[];
        const allowLower = allowlist.map((a) => a.toLowerCase().trim());
        return parts.some((p) => allowLower.includes(p.toLowerCase().trim()));
    }
    return true;
}
