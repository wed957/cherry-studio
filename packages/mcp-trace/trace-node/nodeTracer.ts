import type { Tracer } from '@opentelemetry/api'
import { trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NoopSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

import type { TraceConfig } from '../trace-core/types/config'
import { defaultConfig } from '../trace-core/types/config'

export class NodeTracer {
  private static provider: NodeTracerProvider
  private static defaultTracer: Tracer
  private static spanProcessor: SpanProcessor

  static init(config?: TraceConfig, spanProcessor?: SpanProcessor) {
    if (config) {
      defaultConfig.serviceName = config.serviceName || defaultConfig.serviceName
      defaultConfig.endpoint = config.endpoint || defaultConfig.endpoint
      defaultConfig.headers = config.headers || defaultConfig.headers
      defaultConfig.defaultTracerName = config.defaultTracerName || defaultConfig.defaultTracerName
    }
    // Never export spans automatically. A caller may provide an explicit local processor.
    this.spanProcessor = spanProcessor || new NoopSpanProcessor()
    this.provider = new NodeTracerProvider({
      spanProcessors: [this.spanProcessor]
    })
    this.provider.register({
      propagator: new W3CTraceContextPropagator(),
      contextManager: new AsyncLocalStorageContextManager()
    })
    this.defaultTracer = trace.getTracer(config?.defaultTracerName || 'default')
  }

  public static getTracer() {
    return this.defaultTracer
  }
}
