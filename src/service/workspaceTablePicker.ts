"use strict";

import * as vscode from "vscode";
import { getConnectionDatabaseAllowlist, treeDbNodeMatchesAllowlist } from "../common/connectionScope";
import { DatabaseType } from "../common/constants";
import { ConnectionNode } from "../model/database/connectionNode";
import { CatalogNode } from "../model/database/catalogNode";
import { SchemaNode } from "../model/database/schemaNode";
import { UserGroup } from "../model/database/userGroup";
import { Node } from "../model/interface/node";
import { TableGroup } from "../model/main/tableGroup";
import { TableNode } from "../model/main/tableNode";
import { ConnectionManager } from "./connectionManager";
import { DatabaseCache } from "./common/databaseCache";
import { DbTreeDataProvider } from "../provider/treeDataProvider";
import { ServiceManager } from "./serviceManager";

function isWorkspaceSqlDbType(dbType: DatabaseType): boolean {
    return (
        dbType === DatabaseType.MYSQL ||
        dbType === DatabaseType.PG ||
        dbType === DatabaseType.SQLITE ||
        dbType === DatabaseType.MSSQL ||
        dbType === DatabaseType.EXASOL
    );
}

function getRootConnection(node: Node): ConnectionNode | null {
    let cur: Node | undefined = node;
    while (cur) {
        if (cur instanceof ConnectionNode) {
            return cur;
        }
        cur = cur.parent;
    }
    return null;
}

/**
 * Returns a node suitable as parent of TableGroup (SchemaNode, or SQLite ConnectionNode).
 */
function findTableGroupParent(start: Node | undefined | null): SchemaNode | ConnectionNode | null {
    let n: Node | undefined = start || undefined;
    while (n) {
        if (n instanceof SchemaNode) {
            return n;
        }
        if (n instanceof ConnectionNode && n.dbType === DatabaseType.SQLITE) {
            return n;
        }
        n = n.parent;
    }
    return null;
}

interface TableQuickPickItem extends vscode.QuickPickItem {
    tableNode: TableNode;
}

async function buildWorkspaceSchemaPickMap(
    provider: DbTreeDataProvider
): Promise<{ dbIdList: string[]; dbIdMap: Map<string, Node> }> {
    const dbIdList: string[] = [];
    const dbIdMap = new Map<string, Node>();
    const connectionNodes = await provider.getConnectionNodes();
    const workspaceSql = connectionNodes.filter(
        (c) => c.global === false && isWorkspaceSqlDbType(c.dbType) && !c.disable
    );

    for (const cNode of workspaceSql) {
        if (cNode.dbType === DatabaseType.SQLITE) {
            const uid = cNode.label;
            dbIdList.push(uid);
            dbIdMap.set(uid, cNode);
            continue;
        }

        const allow = getConnectionDatabaseAllowlist(cNode);
        const conn = cNode as ConnectionNode;

        if (cNode.dbType === DatabaseType.MYSQL && allow && allow.length === 1) {
            const only = allow[0];
            const uid = `${cNode.label}#${only}`;
            dbIdList.push(uid);
            dbIdMap.set(uid, new SchemaNode(only, conn));
            continue;
        }

        let schemaList: Node[] | null = null;

        if (cNode.dbType === DatabaseType.MSSQL || cNode.dbType === DatabaseType.PG) {
            let tempList = DatabaseCache.getSchemaListOfConnection(cNode.uid);
            if (!tempList || tempList.length === 0) {
                await conn.getChildren(true);
                tempList = DatabaseCache.getSchemaListOfConnection(cNode.uid);
            }
            schemaList = [];
            if (tempList) {
                for (const catalogNode of tempList) {
                    if (catalogNode instanceof UserGroup) {
                        continue;
                    }
                    if (!treeDbNodeMatchesAllowlist(catalogNode, allow)) {
                        continue;
                    }
                    schemaList.push(...(await catalogNode.getChildren()));
                }
            }
        } else {
            schemaList = DatabaseCache.getSchemaListOfConnection(cNode.uid);
            if (!schemaList || schemaList.length === 0) {
                await conn.getChildren(true);
                schemaList = DatabaseCache.getSchemaListOfConnection(cNode.uid);
            }
        }

        if (!schemaList) {
            schemaList = [];
        }

        for (const schemaNode of schemaList) {
            if (schemaNode instanceof UserGroup || schemaNode instanceof CatalogNode) {
                continue;
            }
            if (!treeDbNodeMatchesAllowlist(schemaNode, allow)) {
                continue;
            }
            let uid = `${cNode.label}#${schemaNode.schema}`;
            if (cNode.dbType === DatabaseType.PG || cNode.dbType === DatabaseType.MSSQL) {
                uid = `${cNode.label}#${schemaNode.database}#${schemaNode.schema}`;
            }
            dbIdList.push(uid);
            dbIdMap.set(uid, schemaNode);
        }
    }

    return { dbIdList, dbIdMap };
}

async function pickSchemaNode(provider: DbTreeDataProvider): Promise<SchemaNode | ConnectionNode | undefined> {
    const { dbIdList, dbIdMap } = await buildWorkspaceSchemaPickMap(provider);
    if (dbIdList.length === 0) {
        vscode.window.showWarningMessage(
            "No workspace SQL connections with a loaded database list. Add a workspace-scoped connection and expand it in the sidebar, or Change Active Database for a workspace connection."
        );
        return undefined;
    }
    if (dbIdList.length === 1) {
        return dbIdMap.get(dbIdList[0]) as SchemaNode | ConnectionNode;
    }
    const picked = await vscode.window.showQuickPick(dbIdList, {
        placeHolder: "Select workspace database / schema",
    });
    if (!picked) {
        return undefined;
    }
    return dbIdMap.get(picked) as SchemaNode | ConnectionNode;
}

async function resolveTableGroupParentNode(): Promise<SchemaNode | ConnectionNode | undefined> {
    const provider = ServiceManager.instance?.provider;
    if (!provider) {
        vscode.window.showErrorMessage("Database client is not initialized.");
        return undefined;
    }

    const active = ConnectionManager.tryGetConnection();
    if (active) {
        const tableParent = findTableGroupParent(active);
        if (tableParent) {
            const root = getRootConnection(tableParent);
            if (root && root.global === false) {
                return tableParent;
            }
        }
    }

    return pickSchemaNode(provider);
}

async function listTablesForParent(parent: SchemaNode | ConnectionNode): Promise<TableNode[]> {
    const tableGroup = new TableGroup(parent);
    const children = await tableGroup.getChildren(true);
    return children.filter((c): c is TableNode => c instanceof TableNode);
}

export async function showWorkspaceTablePicker(): Promise<void> {
    const parent = await resolveTableGroupParentNode();
    if (!parent) {
        return;
    }

    try {
        const tables = await listTablesForParent(parent);
        if (tables.length === 0) {
            vscode.window.showInformationMessage("No tables found for this database.");
            return;
        }
        const items: TableQuickPickItem[] = tables.map((t) => ({
            label: t.table,
            description: (t.description || "").trim() || undefined,
            tableNode: t,
        }));
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: "Type to filter tables",
            matchOnDescription: true,
        });
        if (selected) {
            await selected.tableNode.openInNew();
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Could not list tables: ${msg}`);
    }
}
