// Conexión de la app con Supabase. Esta clave es pública (publishable): solo sirve con las reglas de acceso de la base.
// La "Secret key" (service role) NUNCA va en este archivo ni en ningún otro del proyecto.
window.PROPIO_CONFIG = {
  supabaseUrl: 'https://inhwsqsewvvuyijzhzyi.supabase.co',
  supabaseKey: 'sb_publishable_XhEmYcfVMjIh9aqbJodGiA_zEdIHwg0',
  // Los supervisores entran con "usuario + PIN". Por dentro, Supabase los guarda como usuario@este-dominio (no se envía ningún correo).
  dominioUsuarios: 'propio-sae.app',
};
