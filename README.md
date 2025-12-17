# HN Jobs - Intelligent Job Search Assistant

An AI-powered chat assistant that helps you find the best open roles suited to you personally. The assistant asks you questions about your preferences and skills, then searches through a comprehensive Hacker News jobs index to present you with the most relevant opportunities.

## Features

- **Intelligent Chat Interface**: Interactive conversation-based job search
- **Semantic Search**: Uses embeddings to understand job requirements and match them with your profile
- **Job Data Extraction**: Automatically extracts structured information (company, role, tech stack, seniority, etc.) from unstructured HN job posts
- **Vector Database**: ChromaDB for fast semantic similarity search across thousands of jobs
- **LLM-Powered**: Uses local models (Ollama) and LangChain for intelligent reasoning and search
- **Agent-Based Architecture**: LangGraph agents for multi-step reasoning and tool orchestration

## Architecture

### Core Components

- **`ops/chat.ts`** - Interactive chat interface that uses LangChain agents to understand your needs and retrieve relevant jobs
- **`ops/indexing.ts`** - Processes raw HN job listings, extracts structured data using LLMs, and indexes them in ChromaDB
- **`ops/relevance.ts`** - Evaluates job relevance against your profile

### Data Flow

```
HN Jobs API/Raw Data
    ↓
Indexing Pipeline (LLM extraction + chunking)
    ↓
ChromaDB Vector Store
    ↓
Chat Interface (Agent + Retrieval)
    ↓
User Results
```

## Tech Stack

- **Language**: TypeScript
- **LLM Framework**: LangChain, LangGraph
- **Vector Database**: ChromaDB
- **LLM Models**: Ollama (local), HuggingFace (embeddings)
- **Runtime**: Node.js with ts-node

## Prerequisites

- Node.js 18+
- Docker & Docker Compose (for ChromaDB)
- Ollama (for local LLM inference)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/kbariotis/hn-jobs.git
cd hn-jobs
```

2. Install dependencies:

```bash
npm install
```

3. Set up ChromaDB using Docker Compose:

```bash
docker-compose up -d
```

4. Ensure Ollama is running locally on port 11434

## Usage

### Index Jobs from HN

Process and index Hacker News job listings:

```bash
npm run start -- ops/indexing.ts
```

This will:

- Load raw HN job data from `data/hn.json`
- Extract structured information using the LLM (company, role, tech stack, etc.)
- Chunk the content into semantic pieces
- Store everything in ChromaDB with vector embeddings

### Start the Chat Assistant

Run the interactive job search assistant:

```bash
npm run start -- ops/chat.ts
```

The assistant will:

- Ask you about your preferences and skills
- Perform semantic searches on your behalf
- Present relevant job opportunities with structured details
- Provide context-aware recommendations

## Data

- **`data/hn.json`** - Raw HackerNews job postings
- **`data/gold_set.json`** - Ground truth query-to-job mappings for evaluation
- **`chroma/`** - Vector database storage (persisted)

## Author

[Kostas Bariotis](https://github.com/kbariotis)
