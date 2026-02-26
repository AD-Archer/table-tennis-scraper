import { NextResponse } from "next/server";
import { getEndpointCatalog } from "@/lib/overview";

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoints: getEndpointCatalog(),
  });
}
