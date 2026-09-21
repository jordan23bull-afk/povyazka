#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
yt_diag.py - диагностика доступа к YouTube и получения транскрипций.

Проверяет:
- внешний IP и признаки дата-центра / хостинга / VPN / прокси;
- время ответа youtube.com;
- опционально YouTube Data API v3;
- получение транскрипции через youtube-transcript-api;
- ошибки 429/TooManyRequests, NoTranscriptFound, TranscriptsDisabled и др.

Зависимости:
    pip install requests youtube-transcript-api
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

try:
    import requests
except ImportError:
    print(
        "Нужен пакет requests. Установите зависимости: "
        "pip install requests youtube-transcript-api",
        file=sys.stderr,
    )
    sys.exit(2)


VERSION = "1.0.0"
USER_AGENT = f"yt-diagnostics/{VERSION} (python-requests)"

# Известный публичный TED Talk, обычно имеющий субтитры.
# Если видео станет недоступным, задайте другой --video-id.
DEFAULT_VIDEO_ID = "iG9CE55wbtY"

logger = logging.getLogger("yt_diag")


@dataclass
class CheckResult:
    name: str
    ok: bool = False
    duration_ms: Optional[float] = None
    status_code: Optional[int] = None
    error_code: Optional[str] = None
    details: Dict[str, Any] = field(default_factory=dict)
    recommendations: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def mask_proxy(proxy: Optional[str]) -> Optional[str]:
    """Маскирует логин/пароль в прокси, если они есть."""
    if not proxy:
        return proxy

    if "://" in proxy:
        return re.sub(r"(?<=://)([^:@/]+):([^@/]+)@", "***:***@", proxy)

    return re.sub(r"^([^:@/]+):([^@/]+)@", "***:***@", proxy)


def sanitize_secrets(text: str) -> str:
    """Удаляет типовые секреты из сообщений об ошибках."""
    if not text:
        return text

    # user:pass@host
    text = re.sub(r"(?<=://)([^:@/]+):([^@/]+)@", "***:***@", text)

    # token=... / key=...
    text = re.sub(r"(token|key)=[^&\s]+", r"\1=***", text, flags=re.IGNORECASE)

    return text


def make_session(proxy: Optional[str]) -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
        }
    )

    if proxy:
        session.proxies.update({"http": proxy, "https": proxy})

    return session


def normalize_video_id(value: str) -> str:
    """
    Принимает video_id или ссылку YouTube и возвращает video_id.
    Примеры:
        --video-id iG9CE55wbtY
        --video-id https://www.youtube.com/watch?v=iG9CE55wbtY
        --video-id https://youtu.be/iG9CE55wbtY
    """
    value = (value or "").strip()
    if not value:
        return value

    if "http://" in value or "https://" in value:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()

        if host.endswith("youtu.be"):
            return parsed.path.lstrip("/").split("/")[0]

        if "youtube.com" in host:
            qs = parse_qs(parsed.query)
            if qs.get("v"):
                return qs["v"][0]

            for prefix in ("/shorts/", "/embed/", "/live/"):
                if parsed.path.startswith(prefix):
                    return parsed.path[len(prefix) :].split("/")[0]

    return value


def http_get_json(
    session: requests.Session,
    url: str,
    timeout: float,
    params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    start = time.perf_counter()

    try:
        resp = session.get(url, params=params, timeout=timeout)
        duration_ms = round((time.perf_counter() - start) * 1000, 2)

        try:
            data = resp.json()
        except ValueError:
            data = {"raw": resp.text[:1000]}

        return {
            "ok": resp.status_code < 400,
            "status_code": resp.status_code,
            "duration_ms": duration_ms,
            "data": data,
        }

    except requests.RequestException as exc:
        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        return {
            "ok": False,
            "status_code": None,
            "duration_ms": duration_ms,
            "data": {"error": sanitize_secrets(str(exc))},
        }


def flatten_ipwhois(data: Dict[str, Any]) -> Dict[str, Any]:
    conn = data.get("connection") or {}
    sec = data.get("security") or {}

    return {
        "ip": data.get("ip_address") or data.get("ip"),
        "country": data.get("country"),
        "city": data.get("city"),
        "isp": conn.get("isp"),
        "org": conn.get("org"),
        "domain": conn.get("domain"),
        "asn": conn.get("asn") or data.get("asn"),
        "proxy": sec.get("proxy"),
        "vpn": sec.get("vpn"),
        "tor": sec.get("tor"),
        "hosting": sec.get("hosting"),
    }


def check_ip(
    session: requests.Session,
    timeout: float,
    ipinfo_token: Optional[str],
) -> CheckResult:
    result = CheckResult(name="ip_reputation")
    start = time.perf_counter()

    meta: Dict[str, Any] = {}
    provider_results: Dict[str, Any] = {}

    # ipinfo.io
    params = {"token": ipinfo_token} if ipinfo_token else None
    ipinfo = http_get_json(session, "https://ipinfo.io/json", timeout, params=params)
    provider_results["ipinfo"] = ipinfo
    if ipinfo["ok"] and isinstance(ipinfo["data"], dict):
        meta.update(ipinfo["data"])

    # ipwho.is
    ipwho = http_get_json(session, "https://ipwho.is/", timeout)
    provider_results["ipwhois"] = ipwho
    if (
        ipwho["ok"]
        and isinstance(ipwho["data"], dict)
        and ipwho["data"].get("success", True)
    ):
        flat = flatten_ipwhois(ipwho["data"])
        for k, v in flat.items():
            if v is not None:
                meta[k] = v

    result.details["providers"] = provider_results
    result.details["ip"] = meta.get("ip") or meta.get("query")
    result.details["country"] = meta.get("country")
    result.details["city"] = meta.get("city")
    result.details["isp"] = meta.get("isp")
    result.details["org"] = meta.get("org")
    result.details["asn"] = meta.get("asn") or meta.get("as")

    privacy = meta.get("privacy") if isinstance(meta.get("privacy"), dict) else {}
    security = meta.get("security") if isinstance(meta.get("security"), dict) else {}

    flags = {
        "hosting": bool(
            meta.get("hosting")
            or privacy.get("hosting")
            or security.get("hosting")
        ),
        "proxy": bool(
            meta.get("proxy") or privacy.get("proxy") or security.get("proxy")
        ),
        "vpn": bool(meta.get("vpn") or privacy.get("vpn") or security.get("vpn")),
        "tor": bool(meta.get("tor") or privacy.get("tor") or security.get("tor")),
        "datacenter": bool(meta.get("is_datacenter") or meta.get("datacenter")),
    }
    result.details["flags"] = flags

    reasons: List[str] = []
    score = 0

    if flags["hosting"] or flags["datacenter"]:
        score += 5
        reasons.append("IP помечен как hosting/datacenter")

    if flags["proxy"] or flags["vpn"] or flags["tor"]:
        score += 4
        reasons.append("IP помечен как proxy/VPN/Tor")

    text = " ".join(
        [
            str(result.details.get("isp") or ""),
            str(result.details.get("org") or ""),
            str(result.details.get("asn") or ""),
        ]
    ).lower()

    cloud_keywords = [
        "amazon",
        "aws",
        "google cloud",
        "google llc",
        "microsoft",
        "azure",
        "digitalocean",
        "linode",
        "vultr",
        "ovh",
        "hetzner",
        "oracle",
        "alibaba",
        "tencent",
        "cloudflare",
        "fastly",
        "akamai",
        "scaleway",
        "contabo",
        "hostwinds",
        "hostgator",
        "bluehost",
        "dreamhost",
        "ionos",
    ]

    generic_keywords = [
        "hosting",
        "data center",
        "datacenter",
        "vps",
        "dedicated",
        "colocation",
        "server",
        "cloud",
        "vmware",
        "openstack",
        "kvm",
        "xen",
        "hyper-v",
    ]

    matched_cloud = sorted({kw for kw in cloud_keywords if kw in text})
    if matched_cloud:
        score += 3
        reasons.append(
            "ISP/ORG похож на облачного/хостинг-провайдера: "
            + ", ".join(matched_cloud)
        )

    matched_generic = sorted({kw for kw in generic_keywords if kw in text})
    if matched_generic:
        score += 2
        reasons.append(
            "ISP/ORG содержит хостинг/серверные ключевые слова: "
            + ", ".join(matched_generic)
        )

    is_datacenter = score >= 3
    confidence = "high" if score >= 5 else ("medium" if score >= 3 else "low")

    result.details["score"] = score
    result.details["is_datacenter"] = is_datacenter
    result.details["confidence"] = confidence
    result.details["reasons"] = reasons

    result.ok = bool(result.details.get("ip"))
    result.duration_ms = round((time.perf_counter() - start) * 1000, 2)

    if not result.ok:
        result.error_code = "IpLookupFailed"
        result.recommendations.append(
            "Не удалось определить внешний IP через ipinfo.io/ipwho.is. "
            "Проверьте интернет, прокси и исходящие HTTPS-запросы."
        )
    elif is_datacenter:
        result.recommendations.append(
            "Похоже, выходной IP принадлежит дата-центру/хостингу/облаку. "
            "YouTube чаще ограничивает такие IP. Если задача разрешена правилами сервиса, "
            "используйте чистый резидентный/мобильный или корпоративный выходной IP, "
            "а также снизьте частоту запросов и добавьте кэш."
        )

    if flags["proxy"] or flags["vpn"] or flags["tor"]:
        result.recommendations.append(
            "Обнаружен признак VPN/прокси/Tor. Для стабильной диагностики лучше "
            "использовать прозрачный разрешенный выходной IP."
        )

    return result


def check_youtube_http(session: requests.Session, timeout: float) -> CheckResult:
    result = CheckResult(name="youtube_http")
    url = "https://www.youtube.com/robots.txt"
    result.details["url"] = url

    start = time.perf_counter()

    try:
        resp = session.get(url, timeout=timeout, stream=True)
        result.duration_ms = round((time.perf_counter() - start) * 1000, 2)
        result.status_code = resp.status_code

        # Достаточно прочитать первый кусок и закрыть соединение.
        for _ in resp.iter_content(1024):
            break
        resp.close()

        result.ok = resp.status_code < 400

        if resp.status_code == 429:
            result.error_code = "TooManyRequests"
            logger.error("ERROR_CODE=429_TOO_MANY_REQUESTS url=%s status=429", url)
            result.recommendations.append(
                "YouTube вернул 429 на базовый HTTP-запрос. Снизьте нагрузку, "
                "добавьте экспоненциальный backoff и повторите позже."
            )

        elif resp.status_code == 403:
            result.error_code = "Forbidden"
            logger.error("ERROR_CODE=FORBIDDEN url=%s status=403", url)
            result.recommendations.append(
                "YouTube вернул 403. Возможен блок по IP/User-Agent/cookies. "
                "Проверьте прокси и заголовки, используйте официальный API там, где возможно."
            )

        elif resp.status_code >= 400:
            result.error_code = f"HTTP_{resp.status_code}"

    except requests.RequestException as exc:
        result.duration_ms = round((time.perf_counter() - start) * 1000, 2)
        result.ok = False
        result.error_code = "NetworkError"
        result.details["error"] = sanitize_secrets(str(exc))
        result.recommendations.append(
            "Не удалось подключиться к youtube.com. "
            "Проверьте сеть, DNS, прокси, файрвол и сертификаты."
        )

    return result


def check_youtube_data_api(
    session: requests.Session,
    video_id: str,
    api_key: Optional[str],
    timeout: float,
) -> CheckResult:
    result = CheckResult(name="youtube_data_api")

    if not api_key:
        result.ok = True
        result.details["skipped"] = (
            "Не задан --youtube-api-key/YOUTUBE_API_KEY; "
            "проверка официального Data API пропущена."
        )
        return result

    url = "https://www.googleapis.com/youtube/v3/videos"
    params = {
        "part": "snippet,contentDetails",
        "id": video_id,
        "key": api_key,
    }

    start = time.perf_counter()

    try:
        resp = session.get(url, params=params, timeout=timeout)
        result.duration_ms = round((time.perf_counter() - start) * 1000, 2)
        result.status_code = resp.status_code

        try:
            data = resp.json()
        except ValueError:
            data = {"raw": resp.text[:1000]}

        if resp.status_code == 200:
            result.ok = True
            items = data.get("items", []) if isinstance(data, dict) else []

            if not items:
                result.error_code = "VideoNotFoundOrNotAccessible"
                result.details["note"] = (
                    "API ответил 200, но items пуст. Возможно, видео удалено, "
                    "приватное или указан неверный ID."
                )
            else:
                item = items[0]
                result.details["title"] = item.get("snippet", {}).get("title")
                result.details["caption_flag"] = item.get("contentDetails", {}).get(
                    "caption"
                )

        else:
            result.ok = False
            error_obj = data.get("error", {}) if isinstance(data, dict) else {}
            reason = None

            errors = error_obj.get("errors") if isinstance(error_obj, dict) else None
            if isinstance(errors, list) and errors:
                reason = errors[0].get("reason")

            result.error_code = reason or f"HTTP_{resp.status_code}"
            result.details["api_error"] = error_obj

            if resp.status_code == 429 or reason in {
                "rateLimitExceeded",
                "userRateLimitExceeded",
            }:
                result.error_code = "TooManyRequests"
                logger.error(
                    "ERROR_CODE=429_TOO_MANY_REQUESTS source=youtube_data_api "
                    "status=%s reason=%s",
                    resp.status_code,
                    reason,
                )
                result.recommendations.append(
                    "YouTube Data API вернул 429/rate limit. Уменьшите RPS, "
                    "добавьте backoff, кэш и проверьте квоты проекта."
                )

            elif resp.status_code == 403 and reason == "quotaExceeded":
                result.recommendations.append(
                    "Квота YouTube Data API исчерпана. Снизьте число запросов, "
                    "запросите повышение квоты или используйте кэширование."
                )

            elif resp.status_code == 403 and reason in {
                "ipRefererBlocked",
                "forbidden",
            }:
                result.recommendations.append(
                    "YouTube Data API заблокировал запрос по IP/referer/настройкам ключа. "
                    "Проверьте ограничения ключа и разрешенные домены/IP."
                )

            elif resp.status_code == 400:
                result.recommendations.append(
                    "Проверьте корректность video_id и ключа API."
                )

    except requests.RequestException as exc:
        result.duration_ms = round((time.perf_counter() - start) * 1000, 2)
        result.ok = False
        result.error_code = "NetworkError"

        err_text = sanitize_secrets(str(exc))
        if api_key:
            err_text = err_text.replace(api_key, "***")

        result.details["error"] = err_text

    return result


def _is_exc(exc: Exception, cls: Optional[Any]) -> bool:
    return cls is not None and isinstance(exc, cls)


def get_ytt_exception_classes(module: Any, api_cls: Any) -> Dict[str, Any]:
    names = [
        "TooManyRequests",
        "TranscriptsDisabled",
        "NoTranscriptFound",
        "NoTranscriptAvailable",
        "VideoUnavailable",
        "IpBlocked",
        "RequestBlocked",
        "ResponseError",
    ]

    candidates = [module, api_cls]

    for mod_name in ("exceptions", "_errors"):
        try:
            mod = importlib.import_module(f"youtube_transcript_api.{mod_name}")
            candidates.append(mod)
        except Exception:
            pass

    classes: Dict[str, Any] = {}

    for source in candidates:
        for name in names:
            cls = getattr(source, name, None)
            if isinstance(cls, type):
                classes.setdefault(name, cls)

    return classes


def classify_ytt_exception(exc: Exception, exc_classes: Dict[str, Any]) -> str:
    name = type(exc).__name__
    msg = str(exc).lower()

    status = None
    response = getattr(exc, "response", None)
    if response is not None:
        status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(exc, "status_code", None)

    if (
        status == 429
        or _is_exc(exc, exc_classes.get("TooManyRequests"))
        or name == "TooManyRequests"
        or "429" in msg
        or "too many requests" in msg
    ):
        return "TooManyRequests"

    if (
        _is_exc(exc, exc_classes.get("TranscriptsDisabled"))
        or name == "TranscriptsDisabled"
        or "transcripts disabled" in msg
        or "transcript disabled" in msg
        or ("disabled" in msg and "transcript" in msg)
    ):
        return "TranscriptsDisabled"

    if (
        _is_exc(exc, exc_classes.get("NoTranscriptFound"))
        or _is_exc(exc, exc_classes.get("NoTranscriptAvailable"))
        or name in {"NoTranscriptFound", "NoTranscriptAvailable"}
        or "no transcript" in msg
        or "no subtitles" in msg
    ):
        return "NoTranscriptFound"

    if (
        _is_exc(exc, exc_classes.get("VideoUnavailable"))
        or name == "VideoUnavailable"
        or "video unavailable" in msg
    ):
        return "VideoUnavailable"

    if (
        _is_exc(exc, exc_classes.get("IpBlocked"))
        or _is_exc(exc, exc_classes.get("RequestBlocked"))
        or name in {"IpBlocked", "RequestBlocked"}
        or "ip blocked" in msg
        or "request blocked" in msg
        or "unusual traffic" in msg
        or "please sign in" in msg
    ):
        return "IpBlocked"

    if (
        isinstance(exc, requests.RequestException)
        or "connection" in msg
        or "timeout" in msg
        or "ssl" in msg
    ):
        return "NetworkError"

    return "OtherError"


def list_transcript_info(
    api_cls: Any,
    video_id: str,
    proxies: Optional[Dict[str, str]],
) -> List[Dict[str, Any]]:
    transcript_list = None

    try:
        if hasattr(api_cls, "list_transcripts"):
            try:
                transcript_list = api_cls.list_transcripts(video_id, proxies=proxies)
            except TypeError:
                transcript_list = api_cls.list_transcripts(video_id)
        else:
            try:
                api = api_cls()
            except Exception:
                api = None

            if api is not None and hasattr(api, "list"):
                try:
                    transcript_list = api.list(video_id)
                except TypeError:
                    transcript_list = api.list()

    except TypeError:
        # Если подпись метода отличается, не роняем диагностику только из-за списка.
        return []

    if transcript_list is None:
        return []

    out = []
    for t in transcript_list:
        out.append(
            {
                "language": getattr(t, "language", None),
                "language_code": getattr(t, "language_code", None),
                "is_generated": getattr(t, "is_generated", None),
            }
        )

    return out


def fetch_transcript(
    api_cls: Any,
    video_id: str,
    lang_list: Optional[List[str]],
    proxies: Optional[Dict[str, str]],
) -> Any:
    kwargs = {}
    if lang_list:
        kwargs["languages"] = lang_list

    # Старый/совместимый статический стиль:
    # YouTubeTranscriptApi.get_transcript(...)
    if hasattr(api_cls, "get_transcript"):
        try:
            return api_cls.get_transcript(video_id, proxies=proxies, **kwargs)
        except TypeError:
            try:
                return api_cls.get_transcript(video_id, **kwargs)
            except TypeError:
                return api_cls.get_transcript(video_id)

    # Новый стиль:
    # api = YouTubeTranscriptApi(); api.fetch(...)
    try:
        api = api_cls()
    except Exception:
        api = None

    if api is not None and hasattr(api, "fetch"):
        try:
            return api.fetch(video_id, **kwargs)
        except TypeError:
            return api.fetch(video_id)

    # На случай, если fetch реализован как classmethod/staticmethod.
    if hasattr(api_cls, "fetch"):
        try:
            return api_cls.fetch(video_id, **kwargs)
        except TypeError:
            return api_cls.fetch(video_id)

    raise RuntimeError(
        "Unsupported youtube_transcript_api version: no get_transcript/fetch method found"
    )


def test_transcript(
    video_id: str,
    languages: Optional[str],
    proxies: Optional[Dict[str, str]],
    timeout: float,
) -> CheckResult:
    result = CheckResult(name="transcript")
    start = time.perf_counter()

    result.details["video_id"] = video_id
    result.details["timeout_s"] = timeout

    lang_list = [x.strip() for x in (languages or "").split(",") if x.strip()] or None
    result.details["requested_languages"] = lang_list

    try:
        import youtube_transcript_api as ytt
    except ImportError as exc:
        result.duration_ms = round((time.perf_counter() - start) * 1000, 2)
        result.error_code = "DependencyMissing"
        result.details["error"] = sanitize_secrets(str(exc))
        result.recommendations.append(
            "Установите зависимость: pip install youtube-transcript-api"
        )
        logger.error(
            "ERROR_CODE=DEPENDENCY_MISSING component=youtube_transcript_api error=%s",
            sanitize_secrets(str(exc)),
        )
        return result

    api_cls = getattr(ytt, "YouTubeTranscriptApi", None)
    if api_cls is None:
        result.duration_ms = round((time.perf_counter() - start) * 1000, 2)
        result.error_code = "UnsupportedLibrary"
        result.details["error"] = (
            "Не найден класс YouTubeTranscriptApi в youtube_transcript_api"
        )
        return result

    exc_classes = get_ytt_exception_classes(ytt, api_cls)
    result.details["api_backend"] = "youtube-transcript-api"

    try:
        # Сначала пробуем получить список доступных субтитров.
        # Если список не удался из-за известной ошибки, не делаем лишний fetch.
        try:
            available = list_transcript_info(api_cls, video_id, proxies)
            result.details["available_transcripts"] = available
        except Exception as list_exc:
            code = classify_ytt_exception(list_exc, exc_classes)
            result.details["list_error"] = code
            result.details["list_error_message"] = sanitize_secrets(str(list_exc))[:500]

            # Если ошибка понятная и блокирующая, повторяем её в основном обработчике.
            if code != "OtherError":
                raise

        transcript = fetch_transcript(api_cls, video_id, lang_list, proxies)

        result.ok = True
        result.status_code = 200

        if isinstance(transcript, list):
            result.details["segments"] = len(transcript)

            if transcript:
                first = transcript[0]
                if isinstance(first, dict):
                    result.details["sample_segment"] = {
                        "text": first.get("text"),
                        "start": first.get("start"),
                        "duration": first.get("duration"),
                    }
                else:
                    result.details["sample_segment"] = str(first)[:200]

        else:
            # Новые версии могут возвращать объект с фрагментами.
            result.details["transcript_type"] = str(type(transcript))

            snippets = getattr(transcript, "snippets", None)
            if snippets is not None:
                result.details["segments"] = len(snippets)

                if snippets:
                    s = snippets[0]
                    result.details["sample_segment"] = {
                        "text": getattr(s, "text", None),
                        "start": getattr(s, "start", None),
                        "duration": getattr(s, "duration", None),
                    }

        logger.info(
            "TRANSCRIPT_OK video_id=%s segments=%s",
            video_id,
            result.details.get("segments"),
        )

    except Exception as exc:
        result.ok = False
        code = classify_ytt_exception(exc, exc_classes)
        message = sanitize_secrets(str(exc))[:1000]

        result.error_code = code
        result.details["exception"] = type(exc).__name__
        result.details["message"] = message

        if code == "TooManyRequests":
            logger.error(
                "ERROR_CODE=429_TOO_MANY_REQUESTS source=transcript video_id=%s "
                "exception=%s message=%s",
                video_id,
                type(exc).__name__,
                message[:500],
            )
            result.recommendations.extend(
                [
                    "429/TooManyRequests: снизьте частоту запросов, уберите параллелизм, "
                    "добавьте экспоненциальный backoff и кэш.",
                    "Если лимит связан с IP и это разрешено правилами сервиса, "
                    "используйте менее нагруженный/резидентный прокси с чистой репутацией.",
                ]
            )

        elif code == "NoTranscriptFound":
            logger.error(
                "ERROR_CODE=NO_TRANSCRIPT_FOUND source=transcript video_id=%s "
                "languages=%s message=%s",
                video_id,
                lang_list,
                message[:500],
            )
            result.recommendations.extend(
                [
                    "NoTranscriptFound: для видео нет субтитров на выбранных языках. "
                    "Попробуйте --languages '' (пусто) или другой язык.",
                    "Эта ошибка обычно не связана с IP, смена прокси не должна быть "
                    "основным решением.",
                ]
            )

        elif code == "TranscriptsDisabled":
            logger.error(
                "ERROR_CODE=TRANSCRIPTS_DISABLED source=transcript video_id=%s message=%s",
                video_id,
                message[:500],
            )
            result.recommendations.extend(
                [
                    "TranscriptsDisabled: автор/платформа отключили субтитры для видео. "
                    "Смена IP не поможет.",
                    "Используйте другой публичный видео-пример с разрешенными субтитрами.",
                ]
            )

        elif code == "IpBlocked":
            logger.error(
                "ERROR_CODE=IP_BLOCKED source=transcript video_id=%s message=%s",
                video_id,
                message[:500],
            )
            result.recommendations.extend(
                [
                    "IpBlocked/RequestBlocked: YouTube блокирует запрос. Остановите нагрузку, "
                    "проверьте ToS, используйте официальный API/разрешенный доступ.",
                    "При необходимости и только если это разрешено, рассмотрите чистый "
                    "резидентный/мобильный прокси вместо дата-центрового.",
                ]
            )

        elif code == "VideoUnavailable":
            logger.error("ERROR_CODE=VIDEO_UNAVAILABLE video_id=%s", video_id)
            result.recommendations.append(
                "Видео недоступно/удалено/приватное. Укажите другой --video-id."
            )

        else:
            logger.error(
                "ERROR_CODE=%s source=transcript video_id=%s exception=%s message=%s",
                code,
                video_id,
                type(exc).__name__,
                message[:500],
            )

    finally:
        result.duration_ms = round((time.perf_counter() - start) * 1000, 2)

    return result


def dedup(seq: List[str]) -> List[str]:
    seen = set()
    out = []

    for item in seq:
        if item not in seen:
            out.append(item)
            seen.add(item)

    return out


def collect_recommendations(results: List[CheckResult]) -> List[str]:
    recs: List[str] = []

    for r in results:
        recs.extend(r.recommendations)

    return recs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Диагностика доступа к YouTube и получения транскрипций."
    )

    parser.add_argument(
        "--video-id",
        default=DEFAULT_VIDEO_ID,
        help=(
            "YouTube video ID или полная ссылка. "
            "Например: iG9CE55wbtY или https://www.youtube.com/watch?v=iG9CE55wbtY"
        ),
    )

    parser.add_argument(
        "--languages",
        default="en",
        help=(
            "Коды языков через запятую: en,ru,uk. "
            "Пустая строка --languages '' означает пробовать любой доступный язык."
        ),
    )

    parser.add_argument(
        "--proxy",
        default=os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY"),
        help=(
            "Прокси для requests и, по возможности, для youtube-transcript-api. "
            "Например: http://user:pass@host:port"
        ),
    )

    parser.add_argument(
        "--timeout",
        type=float,
        default=15.0,
        help="Таймаут сетевых запросов в секундах.",
    )

    parser.add_argument(
        "--ipinfo-token",
        default=os.environ.get("IPINFO_TOKEN"),
        help="Токен ipinfo.io для более надежной проверки IP.",
    )

    parser.add_argument(
        "--youtube-api-key",
        default=os.environ.get("YOUTUBE_API_KEY"),
        help="Ключ YouTube Data API v3 для проверки официального API.",
    )

    parser.add_argument(
        "--log-file",
        help="Файл журнала. Например: yt_diag.log",
    )

    parser.add_argument(
        "--debug",
        action="store_true",
        help="Включить DEBUG-логирование.",
    )

    parser.add_argument(
        "--json",
        action="store_true",
        help="Вывести полный отчет в JSON в stdout.",
    )

    return parser.parse_args()


def setup_logging(args: argparse.Namespace) -> None:
    level = logging.DEBUG if args.debug else logging.INFO

    handlers: List[logging.Handler] = [logging.StreamHandler(sys.stderr)]

    if args.log_file:
        handlers.append(logging.FileHandler(args.log_file, encoding="utf-8"))

    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
    )


def print_human_summary(report: Dict[str, Any]) -> None:
    print("\n=== Результаты ===")

    for r in report["results"]:
        status = "OK" if r["ok"] else "FAIL"
        print(
            f"[{status}] {r['name']}: "
            f"duration_ms={r['duration_ms']} "
            f"status={r['status_code']} "
            f"error={r['error_code']}"
        )

        details = r.get("details") or {}

        if details.get("is_datacenter") is not None:
            print(
                f"    IP: {details.get('ip')} "
                f"datacenter={details.get('is_datacenter')} "
                f"confidence={details.get('confidence')}"
            )

            for reason in details.get("reasons", []):
                print(f"    - {reason}")

        if r["name"] == "transcript" and details.get("segments") is not None:
            print(f"    segments={details.get('segments')}")

    print("\n=== Рекомендации ===")

    if report.get("recommendations"):
        for rec in report["recommendations"]:
            print(f"- {rec}")
    else:
        print("- Явных проблем не обнаружено.")


def main() -> None:
    args = parse_args()
    setup_logging(args)

    args.video_id = normalize_video_id(args.video_id)

    # Чтобы библиотеки, использующие окружение, тоже видели прокси.
    if args.proxy:
        os.environ.setdefault("HTTP_PROXY", args.proxy)
        os.environ.setdefault("HTTPS_PROXY", args.proxy)

    session = make_session(args.proxy)
    proxies = {"http": args.proxy, "https": args.proxy} if args.proxy else None

    logger.info(
        "YT_DIAGNOSTICS_START version=%s video_id=%s proxy=%s",
        VERSION,
        args.video_id,
        mask_proxy(args.proxy),
    )

    results: List[CheckResult] = []

    ip_res = check_ip(session, args.timeout, args.ipinfo_token)
    results.append(ip_res)

    yt_http_res = check_youtube_http(session, args.timeout)
    results.append(yt_http_res)

    api_res = check_youtube_data_api(
        session,
        args.video_id,
        args.youtube_api_key,
        args.timeout,
    )
    results.append(api_res)

    tr_res = test_transcript(args.video_id, args.languages, proxies, args.timeout)
    results.append(tr_res)

    recommendations = collect_recommendations(results)

    ip_dc = ip_res.details.get("is_datacenter", False)
    if ip_dc and tr_res.error_code in {"TooManyRequests", "IpBlocked"}:
        recommendations.append(
            "Если блокировки продолжаются на дата-центровом IP и это разрешено "
            "правилами сервиса, рассмотрите смену прокси на чистый "
            "резидентный/мобильный или корпоративный выход с хорошей репутацией."
        )

    if tr_res.error_code == "TooManyRequests":
        recommendations.append(
            "Рекомендуемый режим повторных попыток: 1-2-4-8-16 секунд + случайный jitter; "
            "кэшируйте успешные ответы; не делайте параллельные запросы."
        )

    if tr_res.error_code == "NoTranscriptFound":
        recommendations.append(
            "Попробуйте --languages '' (пустая строка), чтобы проверить любой доступный язык, "
            "или задайте несколько языков: --languages en,ru."
        )

    if tr_res.error_code == "TranscriptsDisabled":
        recommendations.append(
            "TranscriptsDisabled не лечится сменой прокси. "
            "Выберите видео с включенными субтитрами."
        )

    if yt_http_res.error_code == "TooManyRequests":
        recommendations.append(
            "HTTP-слой YouTube уже возвращает 429: остановите нагрузку и повторите диагностику позже."
        )

    recommendations = dedup(recommendations)

    safe_args = vars(args).copy()
    safe_args["proxy"] = mask_proxy(args.proxy)
    safe_args["ipinfo_token"] = "***" if args.ipinfo_token else None
    safe_args["youtube_api_key"] = "***" if args.youtube_api_key else None

    report = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "script_version": VERSION,
        "args": safe_args,
        "summary": {
            "ip": ip_res.details.get("ip"),
            "ip_is_datacenter": ip_res.details.get("is_datacenter"),
            "ip_confidence": ip_res.details.get("confidence"),
            "youtube_http_status": yt_http_res.status_code,
            "youtube_http_duration_ms": yt_http_res.duration_ms,
            "data_api_status": api_res.status_code,
            "data_api_error": api_res.error_code,
            "transcript_ok": tr_res.ok,
            "transcript_error": tr_res.error_code,
            "transcript_duration_ms": tr_res.duration_ms,
        },
        "results": [r.to_dict() for r in results],
        "recommendations": recommendations,
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human_summary(report)

    logger.info(
        "YT_DIAGNOSTICS_DONE transcript_ok=%s error=%s",
        tr_res.ok,
        tr_res.error_code,
    )

    sys.exit(0 if tr_res.ok else 1)


if __name__ == "__main__":
    main()