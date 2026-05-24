import os
import time
import requests

def generate_response(
    user_prompt: str,
    system_prompt: str = "",
    provider: str = "gemini",
    model: str = "",
    max_tokens: int = 1024,
    local_endpoint: str = "http://localhost:11434/api/chat",
    max_retries: int = 5
) -> str
    provider = provider.lower()
    last_error = None

    for attempt in range(max_retries):
        try:
            if provider == "gemini":
                from google import genai
                from google.genai import types
                
                api_key = os.environ.get("GEMINI_API_KEY")
                if not api_key: raise EnvironmentError("Gemini API key not found.")
                
                client = genai.Client(api_key=api_key)
                model_name = model or "gemini-2.5-flash"
                
                config_kwargs = {"max_output_tokens": max_tokens}
                if system_prompt: config_kwargs["system_instruction"] = system_prompt
                    
                if "gemma" not in model_name.lower():
                    config_kwargs["safety_settings"] = [
                        types.SafetySetting(category="HARM_CATEGORY_HARASSMENT", threshold="BLOCK_ONLY_HIGH"),
                        types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH", threshold="BLOCK_ONLY_HIGH"),
                        types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold="BLOCK_ONLY_HIGH"),
                        types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="BLOCK_ONLY_HIGH"),
                    ]
                    if "json" in system_prompt.lower() or "json" in user_prompt.lower():
                        config_kwargs["response_mime_type"] = "application/json"
                
                config = types.GenerateContentConfig(**config_kwargs)
                response = client.models.generate_content(model=model_name, contents=user_prompt, config=config)
                if response.text is None: raise ValueError("API returned None (safety block).")
                return response.text

            elif provider == "claude":
                import anthropic
                api_key = os.environ.get("ANTHROPIC_API_KEY")
                if not api_key: raise EnvironmentError("Claude API key not found.")
                
                model_name = model or "claude-3-5-sonnet-latest"
                client = anthropic.Anthropic(api_key=api_key)
                msg = client.messages.create(
                    model=model_name,
                    max_tokens=max_tokens,
                    system=system_prompt,
                    messages=[{"role": "user", "content": user_prompt}]
                )
                if msg.content[0].text is None: raise ValueError("Claude returned None.")
                return msg.content[0].text

            elif provider == "chatgpt":
                import openai
                api_key = os.environ.get("OPENAI_API_KEY")
                if not api_key: raise EnvironmentError("ChatGPT API key not found.")
                
                model_name = model or "gpt-4o-mini"
                client = openai.OpenAI(api_key=api_key)
                res = client.chat.completions.create(
                    model=model_name,
                    max_tokens=max_tokens,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ]
                )
                if res.choices[0].message.content is None: raise ValueError("ChatGPT returned None.")
                return res.choices[0].message.content

            elif provider == "local":
                model_name = model or "llama3"
                payload = {
                    "model": model_name,
                    "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                    "stream": False,
                    "options": {"num_predict": max_tokens}
                }
                res = requests.post(local_endpoint, json=payload, timeout=120)
                res.raise_for_status()
                content = res.json().get("message", {}).get("content")
                if content is None: raise ValueError("Local model returned None.")
                return content

            else:
                raise ValueError(f"Unsupported LLM provider: {provider}")

        except Exception as e:
            last_error = e
            err_str = str(e).lower()
            if attempt < max_retries - 1:
                # Rate limits
                if any(x in err_str for x in ["429", "too many requests", "quota"]):
                    time.sleep(10 * (attempt + 1))
                    continue
                # Network drops / 500s
                elif any(x in err_str for x in ["500", "503", "unavailable", "timeout", "internal error", "none", "name resolution", "errno -3", "connection"]):
                    time.sleep(2 ** (attempt + 1))
                    continue
            break
            
    raise last_error