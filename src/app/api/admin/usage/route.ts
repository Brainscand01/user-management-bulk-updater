import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get all usage records, ordered by most recent
    const { data: records, error } = await supabase
      .from('api_usage')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const allRecords = records || [];

    // Calculate aggregates
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const monthRecords = allRecords.filter(r => r.created_at >= startOfMonth);
    const todayRecords = allRecords.filter(r => r.created_at >= startOfDay);

    const sumCost = (recs: typeof allRecords) =>
      recs.reduce((sum, r) => sum + Number(r.cost_usd), 0);
    const sumInput = (recs: typeof allRecords) =>
      recs.reduce((sum, r) => sum + Number(r.input_tokens), 0);
    const sumOutput = (recs: typeof allRecords) =>
      recs.reduce((sum, r) => sum + Number(r.output_tokens), 0);

    // Group by file for recent activity
    const byFile: Record<string, { cost: number; sheets: number; lastUsed: string; user: string }> = {};
    for (const r of allRecords) {
      if (!byFile[r.file_name]) {
        byFile[r.file_name] = { cost: 0, sheets: 0, lastUsed: r.created_at, user: r.user_email || '' };
      }
      byFile[r.file_name].cost += Number(r.cost_usd);
      byFile[r.file_name].sheets++;
    }

    const recentFiles = Object.entries(byFile)
      .map(([name, data]) => ({ fileName: name, ...data }))
      .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
      .slice(0, 20);

    return NextResponse.json({
      totals: {
        allTime: { cost: sumCost(allRecords), inputTokens: sumInput(allRecords), outputTokens: sumOutput(allRecords), calls: allRecords.length },
        thisMonth: { cost: sumCost(monthRecords), inputTokens: sumInput(monthRecords), outputTokens: sumOutput(monthRecords), calls: monthRecords.length },
        today: { cost: sumCost(todayRecords), inputTokens: sumInput(todayRecords), outputTokens: sumOutput(todayRecords), calls: todayRecords.length },
      },
      recentFiles,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
