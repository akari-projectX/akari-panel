// @generated from proto/protocols.toml by `make gen-protocols` (W26). Do not edit.
// The admin node form (admin-protocol-form.ts) reads the protocol layer from here.

export interface ManifestField {
  name: string;
  label_zh: string;
  type: string;
  values: string[];
  value_labels_zh: string[];
  default: string | null;
  required: boolean;
  help_zh: string | null;
}

export interface ManifestProtocol {
  id: string;
  wire: string;
  label: string;
  label_zh: string;
  transports: string[];
  security: string[];
  l4: string;
  template_requires_tls: boolean;
  options: ManifestField[];
}

export interface ManifestLayer {
  id: string;
  label: string;
  label_zh: string;
  fields: ManifestField[];
}

export interface ManifestRule {
  id: string;
  template_only: boolean;
  when: Record<string, string[]>;
  require: Record<string, string[]>;
  doc: string;
}

export interface ManifestUnsupported {
  protocol: string[];
  protocol_not: string[];
  transport: string[];
  security: string[];
  reason: string;
}

export interface ManifestFormat {
  id: string;
  label: string;
  unsupported: ManifestUnsupported[];
}

export interface ProtocolManifest {
  kernel_version: string | null;
  protocols: ManifestProtocol[];
  transports: ManifestLayer[];
  securities: ManifestLayer[];
  rules: ManifestRule[];
  formats: ManifestFormat[];
}

export const MANIFEST: ProtocolManifest = {
  "formats": [
    {
      "id": "links",
      "label": "Links (v2rayN/Shadowrocket)",
      "unsupported": []
    },
    {
      "id": "clash",
      "label": "Clash (mihomo)",
      "unsupported": [
        {
          "protocol": [],
          "protocol_not": [
            "vless"
          ],
          "reason": "mihomo supports xhttp only for vless",
          "security": [],
          "transport": [
            "xhttp"
          ]
        }
      ]
    },
    {
      "id": "sing-box",
      "label": "sing-box",
      "unsupported": [
        {
          "protocol": [],
          "protocol_not": [],
          "reason": "sing-box has no xhttp transport",
          "security": [],
          "transport": [
            "xhttp"
          ]
        }
      ]
    }
  ],
  "kernel_version": "v26.3.27",
  "protocols": [
    {
      "id": "vless",
      "l4": "tcp",
      "label": "VLESS",
      "label_zh": "VLESS",
      "options": [
        {
          "default": "",
          "help_zh": null,
          "label_zh": "流控",
          "name": "flow",
          "required": false,
          "type": "enum",
          "value_labels_zh": [
            "无",
            "Vision（xtls-rprx-vision）"
          ],
          "values": [
            "",
            "xtls-rprx-vision"
          ]
        },
        {
          "default": "none",
          "help_zh": null,
          "label_zh": "加密",
          "name": "encryption",
          "required": false,
          "type": "enum",
          "value_labels_zh": [],
          "values": [
            "none"
          ]
        }
      ],
      "security": [
        "none",
        "tls",
        "reality"
      ],
      "template_requires_tls": false,
      "transports": [
        "tcp",
        "ws",
        "httpupgrade",
        "xhttp",
        "grpc"
      ],
      "wire": "vless"
    },
    {
      "id": "vmess",
      "l4": "tcp",
      "label": "VMess",
      "label_zh": "VMess",
      "options": [],
      "security": [
        "none",
        "tls"
      ],
      "template_requires_tls": false,
      "transports": [
        "tcp",
        "ws",
        "httpupgrade",
        "xhttp",
        "grpc"
      ],
      "wire": "vmess"
    },
    {
      "id": "trojan",
      "l4": "tcp",
      "label": "Trojan",
      "label_zh": "Trojan",
      "options": [],
      "security": [
        "none",
        "tls"
      ],
      "template_requires_tls": true,
      "transports": [
        "tcp",
        "ws",
        "httpupgrade",
        "xhttp",
        "grpc"
      ],
      "wire": "trojan"
    },
    {
      "id": "ss2022",
      "l4": "option:network",
      "label": "Shadowsocks 2022",
      "label_zh": "Shadowsocks 2022",
      "options": [
        {
          "default": "2022-blake3-aes-128-gcm",
          "help_zh": null,
          "label_zh": "加密方式",
          "name": "method",
          "required": false,
          "type": "enum",
          "value_labels_zh": [],
          "values": [
            "2022-blake3-aes-128-gcm",
            "2022-blake3-aes-256-gcm"
          ]
        },
        {
          "default": null,
          "help_zh": null,
          "label_zh": "服务端密钥",
          "name": "psk",
          "required": true,
          "type": "base64_key",
          "value_labels_zh": [],
          "values": []
        },
        {
          "default": "tcp,udp",
          "help_zh": null,
          "label_zh": "网络",
          "name": "network",
          "required": false,
          "type": "l4_list",
          "value_labels_zh": [],
          "values": [
            "tcp",
            "udp"
          ]
        }
      ],
      "security": [
        "none"
      ],
      "template_requires_tls": false,
      "transports": [
        "native"
      ],
      "wire": "shadowsocks"
    },
    {
      "id": "hysteria2",
      "l4": "udp",
      "label": "Hysteria 2",
      "label_zh": "Hysteria 2",
      "options": [],
      "security": [
        "tls"
      ],
      "template_requires_tls": false,
      "transports": [
        "native"
      ],
      "wire": "hysteria"
    }
  ],
  "rules": [
    {
      "doc": "REALITY only with VLESS",
      "id": "reality_protocol",
      "require": {
        "protocol": [
          "vless"
        ]
      },
      "template_only": false,
      "when": {
        "security": [
          "reality"
        ]
      }
    },
    {
      "doc": "REALITY only over raw TCP, XHTTP or gRPC",
      "id": "reality_transport",
      "require": {
        "transport": [
          "tcp",
          "xhttp",
          "grpc"
        ]
      },
      "template_only": false,
      "when": {
        "security": [
          "reality"
        ]
      }
    },
    {
      "doc": "Vision (xtls-rprx-vision) only on raw TCP with TLS or REALITY",
      "id": "vision",
      "require": {
        "security": [
          "tls",
          "reality"
        ],
        "transport": [
          "tcp"
        ]
      },
      "template_only": false,
      "when": {
        "option.flow": [
          "xtls-rprx-vision"
        ]
      }
    },
    {
      "doc": "the templates put gRPC behind TLS",
      "id": "grpc_tls",
      "require": {
        "security": [
          "tls",
          "reality"
        ]
      },
      "template_only": true,
      "when": {
        "transport": [
          "grpc"
        ]
      }
    }
  ],
  "securities": [
    {
      "fields": [],
      "id": "none",
      "label": "none",
      "label_zh": "无"
    },
    {
      "fields": [
        {
          "default": null,
          "help_zh": "留空 = 节点域名",
          "label_zh": "证书域名（SNI）",
          "name": "server_name",
          "required": false,
          "type": "domain",
          "value_labels_zh": [],
          "values": []
        }
      ],
      "id": "tls",
      "label": "TLS",
      "label_zh": "TLS（节点证书）"
    },
    {
      "fields": [
        {
          "default": null,
          "help_zh": "host 或 host:port（默认 443）；留空 = 列表第一个",
          "label_zh": "目标站点",
          "name": "dest",
          "required": false,
          "type": "dest",
          "value_labels_zh": [],
          "values": []
        },
        {
          "default": null,
          "help_zh": "留空 = 目标站点的域名",
          "label_zh": "SNI",
          "name": "server_name",
          "required": false,
          "type": "domain",
          "value_labels_zh": [],
          "values": []
        },
        {
          "default": "chrome",
          "help_zh": null,
          "label_zh": "uTLS 指纹",
          "name": "fingerprint",
          "required": false,
          "type": "enum",
          "value_labels_zh": [],
          "values": [
            "chrome",
            "firefox",
            "safari",
            "ios",
            "android",
            "edge",
            "360",
            "qq",
            "random",
            "randomized"
          ]
        }
      ],
      "id": "reality",
      "label": "REALITY",
      "label_zh": "REALITY"
    }
  ],
  "transports": [
    {
      "fields": [],
      "id": "tcp",
      "label": "raw TCP",
      "label_zh": "TCP（raw）"
    },
    {
      "fields": [
        {
          "default": null,
          "help_zh": "以 / 开头；留空 = 随机",
          "label_zh": "路径",
          "name": "path",
          "required": false,
          "type": "path",
          "value_labels_zh": [],
          "values": []
        },
        {
          "default": null,
          "help_zh": "客户端发送的 Host 头（可选）",
          "label_zh": "Host",
          "name": "host",
          "required": false,
          "type": "host",
          "value_labels_zh": [],
          "values": []
        }
      ],
      "id": "ws",
      "label": "WebSocket",
      "label_zh": "WebSocket"
    },
    {
      "fields": [
        {
          "default": null,
          "help_zh": "以 / 开头；留空 = 随机",
          "label_zh": "路径",
          "name": "path",
          "required": false,
          "type": "path",
          "value_labels_zh": [],
          "values": []
        },
        {
          "default": null,
          "help_zh": "客户端发送的 Host 头（可选）",
          "label_zh": "Host",
          "name": "host",
          "required": false,
          "type": "host",
          "value_labels_zh": [],
          "values": []
        }
      ],
      "id": "httpupgrade",
      "label": "HTTPUpgrade",
      "label_zh": "HTTPUpgrade"
    },
    {
      "fields": [
        {
          "default": null,
          "help_zh": "以 / 开头；留空 = 随机",
          "label_zh": "路径",
          "name": "path",
          "required": false,
          "type": "path",
          "value_labels_zh": [],
          "values": []
        },
        {
          "default": null,
          "help_zh": "客户端发送的 Host 头（可选）",
          "label_zh": "Host",
          "name": "host",
          "required": false,
          "type": "host",
          "value_labels_zh": [],
          "values": []
        },
        {
          "default": "auto",
          "help_zh": null,
          "label_zh": "模式",
          "name": "mode",
          "required": false,
          "type": "enum",
          "value_labels_zh": [],
          "values": [
            "auto",
            "packet-up",
            "stream-up",
            "stream-one"
          ]
        }
      ],
      "id": "xhttp",
      "label": "XHTTP",
      "label_zh": "XHTTP"
    },
    {
      "fields": [
        {
          "default": null,
          "help_zh": "留空 = 随机",
          "label_zh": "serviceName",
          "name": "service_name",
          "required": false,
          "type": "service_name",
          "value_labels_zh": [],
          "values": []
        }
      ],
      "id": "grpc",
      "label": "gRPC",
      "label_zh": "gRPC"
    },
    {
      "fields": [],
      "id": "native",
      "label": "(own)",
      "label_zh": "协议自带"
    }
  ]
};
