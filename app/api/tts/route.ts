import { NextRequest, NextResponse } from 'next/server'

// Premade voices — free on all ElevenLabs plans
const VOICES: Record<string, string> = {
  ana:    'EXAVITQu4vr4xnSDxMaL', // Sarah  — female, warm, multilingual
  carlos: 'nPczCjzI2devNBz1zQrb', // Brian  — male,   deep, multilingual
}
const DEFAULT_VOICE = VOICES.ana

export async function POST(req: NextRequest) {
  const { text, voiceKey } = await req.json()

  if (!text?.trim()) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 })
  }

  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'ELEVENLABS_API_KEY not configured' }, { status: 500 })
  }

  const voiceId = VOICES[voiceKey as string] ?? DEFAULT_VOICE

  const elevenRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: text.trim(),
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  })

  if (!elevenRes.ok) {
    const detail = await elevenRes.text()
    console.error('[ElevenLabs]', elevenRes.status, detail)
    return NextResponse.json({ error: detail }, { status: elevenRes.status })
  }

  const audio = await elevenRes.arrayBuffer()
  return new NextResponse(audio, {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache' },
  })
}
