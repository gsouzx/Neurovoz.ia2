import { NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { mensagemUsuario, historicoAnterior, child, apiKey } = body

    // 1. Identificar a API Key
    const finalApiKey = apiKey || process.env.GEMINI_API_KEY
    if (!finalApiKey) {
      console.warn('\n=== [NeuroVoz] AVISO: Sem chave de API ===')
      console.warn('Nenhuma chave encontrada no .env.local ou enviada pelo cliente.')
      console.warn('=========================================\n')
      return NextResponse.json(
        { error: 'Chave de API do Gemini não fornecida. Configure no arquivo .env.local ou nas Configurações do painel.' },
        { status: 400 }
      )
    }

    if (!mensagemUsuario) {
      return NextResponse.json(
        { error: 'A mensagem do usuário é obrigatória.' },
        { status: 400 }
      )
    }

    // Mascarar a chave para exibir de forma segura no terminal
    const keySource = apiKey ? 'Painel de Configurações (Cliente)' : 'Arquivo .env.local (Servidor)'
    const maskedKey = finalApiKey.length > 10
      ? `${finalApiKey.substring(0, 6)}...${finalApiKey.substring(finalApiKey.length - 4)}`
      : 'Chave inválida/curta'

    console.log(`\n=== [NeuroVoz] Requisição de Chat Recebida ===`)
    console.log(`- Origem da Chave: ${keySource}`)
    console.log(`- Chave Utilizada: ${maskedKey}`)
    console.log(`- Usuário: ${child?.name || 'Criança'} (Nível de Suporte: ${child?.supportLevel || 2})`)
    console.log(`- Mensagem do Usuário: "${mensagemUsuario}"`)

    // 2. Inicializar o cliente oficial da Google GenAI
    const ai = new GoogleGenAI({ apiKey: finalApiKey })

    // 3. Prompt do Sistema (Instrução Jarvis / Neurovoz com Salvaguardas Críticas)
    const BASE_SYSTEM_INSTRUCTION = `Você é o Neurovoz, um agente de IA especializado, paciente e acolhedor, projetado para interagir com pessoas autistas e ajudá-las a desenvolver habilidades sociais e de comunicação. Sua interface é estilo Jarvis: inteligente, focada e direta.

=== DIRETRIZES ABSOLUTAS DE SEGURANÇA E SALVAGUARDA (PRIORIDADE MÁXIMA) ===
1. CONTEÚDO DE RISCO E AUTOMUTILAÇÃO: Se o usuário mencionar suicídio, automutilação, desejo de sumir, machucar a si mesmo ou a outros, quebre imediatamente o tom amigável ou de brincadeira. Responda de forma extremamente séria, curta, acolhedora, porém focada em segurança. Diga explicitamente que a vida dele importa e peça para ele conversar com o responsável ou com um adulto imediatamente. NUNCA concorde, valide ou diga que o assunto é legal ou interessante.
2. COMPORTAMENTOS PERIGOSOS: Se o usuário disser que é "legal" ou que quer brincar com coisas perigosas (como fogo, tomadas, facas, remédios, venenos, alturas, etc.), corrija-o imediatamente de forma firme, clara e literal: "Isso não é seguro. Brincar com isso pode te machucar gravemente. Por favor, fique longe disso". NUNCA apoie ações perigosas.

=== DIRETRIZES DE COMPORTAMENTO PADRÃO ===
1. LINGUAGEM LITERAL E CLARA: Nunca use ironias, sarcasmo, metáforas complexas, figuras de linguagem ou expressões de duplo sentido. Pessoas autistas podem interpretar tudo de forma literal.
2. ENGAJAMENTO SOCIAL ATIVO: Nunca responda com uma frase só sem dar continuidade. Sempre que o usuário cumprimentar, perguntar como você está, ou fizer um comentário casual, responda com interesse genuíno E faça uma pergunta de volta para manter a conversa fluindo. Exemplo: se o usuário disser "bom dia", responda "Bom dia! Fico muito feliz em te ver aqui. Como você está se sentindo hoje?" — nunca apenas "Bom dia." ou "Estou bem."
3. COMUNICAÇÃO EM ETAPAS: Faça apenas UMA pergunta de cada vez. Respostas curtas a médias, sem listas ou parágrafos longos.
4. VALIDAÇÃO EMOCIONAL: Sempre reconheça e valide explicitamente o estado emocional do usuário quando for seguro (Ex: "Entendo que você está frustrado, e está tudo bem"). NUNCA valide sentimentos de empolgação com o perigo ou autodestruição.
5. ESTRUTURAÇÃO VISUAL: Use frases curtas. Pule linhas entre ideias diferentes para facilitar a leitura.
6. TOM DE VOZ: Mantenha um tom de voz calmo, encorajador, previsível e seguro. Evite respostas ambíguas.`

    // Personalização baseada nos dados da criança, se fornecidos
    let systemInstruction = BASE_SYSTEM_INSTRUCTION
    if (child) {
      systemInstruction += `\n\nVocê está conversando com a criança:
- Nome: ${child.name} (${child.age} anos)
- Nível de suporte TEA: Nível ${child.supportLevel}
- Hiperfocos: ${child.hyperfocuses?.join(', ') || 'Nenhum'}
- Personagens favoritos: ${child.favoriteCharacters?.join(', ') || 'Nenhum'}
- Objetivos de desenvolvimento: ${child.developmentGoals?.join(', ') || 'Nenhum'}

Regras específicas por nível de suporte:
- Nível 1: Linguagem natural, pode usar conceitos abstratos simples de forma clara.
- Nível 2: Linguagem simples, direta, estruturada e com exemplos concretos.
- Nível 3: Frases muito curtas, simples, focadas e com o apoio de emojis visuais.`
    }

    // 4. Formatar o histórico para a API do Gemini
    const formattedHistory = (historicoAnterior || []).map((msg: any) => {
      const role = msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user'
      const text = msg.content || (msg.parts?.[0]?.text) || ''
      return {
        role,
        parts: [{ text }]
      }
    })

    // 5. Enviar a mensagem com fallback de modelo caso ocorra erro 404
    let respostaTexto = ''
    try {
      console.log(`- Iniciando chat com o modelo: gemini-1.5-flash...`)
      const chat = ai.chats.create({
        model: 'gemini-1.5-flash',
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.8,
        },
        history: formattedHistory
      })
      const resultado = await chat.sendMessage({
        message: mensagemUsuario
      })
      respostaTexto = resultado.text || ''
    } catch (err: any) {
      const errMsg = err.message || ''
      if (err.status === 404 || errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('not supported')) {
        console.warn(`[NeuroVoz] Modelo gemini-1.5-flash indisponível (404/Não suportado). Tentando fallback com gemini-2.5-flash...`)
        const fallbackChat = ai.chats.create({
          model: 'gemini-2.5-flash',
          config: {
            systemInstruction: systemInstruction,
            temperature: 0.8,
          },
          history: formattedHistory
        })
        const resultado = await fallbackChat.sendMessage({
          message: mensagemUsuario
        })
        respostaTexto = resultado.text || ''
      } else {
        throw err
      }
    }

    console.log(`[NeuroVoz] Conexão com I.A: OK. Resposta gerada com sucesso!`)
    console.log(`=== [NeuroVoz] Fim da Requisição ===\n`)

    // 7. Retornar resposta
    return NextResponse.json({
      respostaNeurovoz: respostaTexto
    })

  } catch (error: any) {
    console.error('\n=== [NeuroVoz] ERRO NA CONEXÃO COM A I.A ===')
    console.error('Mensagem de erro:', error.message || error)
    if (error.status) {
      console.error('Código HTTP:', error.status)
    }
    console.error('===========================================\n')
    return NextResponse.json(
      { error: 'Erro ao processar o diálogo.', details: error.message || error },
      { status: 500 }
    )
  }
}
