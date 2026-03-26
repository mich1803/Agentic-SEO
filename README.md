# Agentic SEO - Bulk Content Generator

Web-app minimale per generare contenuti SEO in massa da template Excel (`.xlsx`) per:
- **Articoli prodotto**
- **Categorie ecommerce**

L'app legge ogni riga del template, invia una chiamata a OpenAI con i prompt dedicati, riceve un JSON e scrive i campi di output nello stesso foglio, compilando anche le colonne `len(...)` con la lunghezza in caratteri.

---

## 1) Requisiti

- Browser moderno (Chrome/Edge/Firefox)
- Connessione internet
- API key OpenAI attiva
- Python 3 (solo per servire i file in localhost)

> Nota: la libreria Excel viene caricata via CDN (`SheetJS`).

---

## 2) Avvio in localhost

Dalla root della repo:

```bash
cd /workspace/Agentic-SEO
python -m http.server 8000
```

Apri il browser su:

- `http://localhost:8000`

---

## 3) Home page

Nella home puoi scegliere due flussi:

1. **Genera Contenuti per Articolo**
2. **Genera Contenuti per Categoria**

Ogni sezione ha il pulsante per scaricare il template Excel ufficiale:
- `article/article_template.xlsx`
- `category/category_template.xlsx`

---

## 4) Flusso "Genera Contenuti per Articolo"

### Passi operativi

1. Vai nella sezione **Genera Contenuti per Articolo**.
2. Scarica il template con il pulsante dedicato.
3. Compila una o più righe nel file `.xlsx`.
4. Nel form inserisci:
   - Modello OpenAI (attualmente `gpt-4.1-mini`)
   - API key OpenAI (campo password)
   - Upload del template compilato
5. Clicca **Genera file output**.

### Cosa succede in elaborazione

Per ogni riga non vuota:
- L'app costruisce il blocco input solo con i campi realmente presenti.
- Se `Descrizione` o `Scheda_Tecnica` contengono **solo un URL**, prova a recuperare il contenuto testuale del link e lo inserisce nel prompt.
- Invia system prompt + user prompt a OpenAI.
- Fa parsing del JSON ritornato (`OUTPUT`).
- Scrive i campi nelle colonne output.
- Aggiorna le colonne `len(nome_campo)` con la lunghezza caratteri.

Viene mostrata una **rotellina di caricamento** e la **percentuale righe processate**.

Alla fine viene scaricato un file:
- `article_output_<timestamp>.xlsx`

---

## 5) Flusso "Genera Contenuti per Categoria"

Stessi passaggi del flusso articoli, ma con prompt categoria e output categoria.

Output finale scaricato come:
- `category_output_<timestamp>.xlsx`

---

## 6) Prompt usati dalla web-app

- **Articoli**
  - `article/article_system_prompt.txt`
  - `article/article_prompt.txt`
- **Categorie**
  - `category/category_system_prompt.txt`
  - `category/category_prompt.txt`

I file prompt sono stati resi più pratici con il placeholder `{{INPUT_BLOCK}}`, sostituito runtime con i soli campi valorizzati della riga.

---

## 7) Suggerimenti pratici

- Compila poche righe per test iniziale.
- Verifica in output coerenza dei campi HTML e lunghezze tag.
- Mantieni i nomi colonna del template.
- Se una riga fallisce lato API, l'app continua le altre righe (quella riga resta vuota negli output).

---

## 8) Limiti noti

- La lettura contenuto URL dipende dall'accessibilità del link.
- Alcuni siti possono bloccare il recupero automatico del testo.
- Se la libreria CDN non è raggiungibile, il parsing `.xlsx` non parte.

