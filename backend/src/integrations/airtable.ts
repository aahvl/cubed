import { config } from "../config.js";

const AIRTABLE_API = "https://api.airtable.com/v0";
const AIRTABLE_CONTENT_API = "https://content.airtable.com/v0";

async function airtableFetch(path: string, init: RequestInit) {
  const response = await fetch(`${AIRTABLE_API}/${config.airtable.baseId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.airtable.pat}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Airtable request failed: ${response.status} ${body}`);
  }

  return response.json();
}

export async function createRecord(tableId: string, fields: Record<string, unknown>) {
  const result = (await airtableFetch(`/${tableId}`, {
    method: "POST",
    body: JSON.stringify({ fields }),
  })) as { id: string };

  return result.id;
}

// File content only ever lives in request memory — never written to disk.
export async function uploadAttachment(
  tableId: string,
  recordId: string,
  fieldId: string,
  base64Content: string,
  contentType: string,
  filename: string,
) {
  const response = await fetch(
    `${AIRTABLE_CONTENT_API}/${config.airtable.baseId}/${recordId}/${fieldId}/uploadAttachment`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.airtable.pat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contentType,
        file: base64Content,
        filename,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Airtable attachment upload failed: ${response.status} ${body}`);
  }
}

export async function getRecord(tableId: string, recordId: string) {
  return (await airtableFetch(`/${tableId}/${recordId}`, { method: "GET" })) as {
    id: string;
    fields: Record<string, unknown>;
  };
}

export async function listRecords(tableId: string) {
  const records: { id: string; fields: Record<string, unknown> }[] = [];
  let offset: string | undefined;

  do {
    const query = offset ? `?offset=${offset}` : "";
    const page = (await airtableFetch(`/${tableId}${query}`, { method: "GET" })) as {
      records: { id: string; fields: Record<string, unknown> }[];
      offset?: string;
    };
    records.push(...page.records);
    offset = page.offset;
  } while (offset);

  return records;
}
