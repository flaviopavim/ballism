<?php
// signal.php - Versão FINAL com Limpeza de Estado e Emparelhamento

header('Content-Type: application/json');

// --- Configuração e Caminhos ---
$data_dir = __DIR__ . '/data/';
$queue_file = $data_dir . 'queue.json'; 
$rooms_file = $data_dir . 'rooms.json'; 
$peers_dir = $data_dir . 'peers/';     

if (!is_dir($data_dir)) { mkdir($data_dir, 0777, true); }
if (!is_dir($peers_dir)) { mkdir($peers_dir, 0777, true); }

// --- Funções de Ajuda ---

function get_peer_filepath($peer_id) {
    global $peers_dir;
    $safe_id = preg_replace('/[^a-zA-Z0-9_-]/', '', $peer_id);
    return $peers_dir . $safe_id . '.json';
}

function read_json_file($filepath) {
    if (!file_exists($filepath) || filesize($filepath) === 0) {
        return [];
    }
    $content = file_get_contents($filepath);
    return json_decode($content, true) ?: [];
}

function write_json_file($filepath, $data) {
    $json_data = json_encode($data, JSON_PRETTY_PRINT);
    return file_put_contents($filepath, $json_data, LOCK_EX);
}

// --- Funções de Gerenciamento de Salas ---

function clear_room_and_queue($peer_id) {
    global $queue_file, $rooms_file;
    
    // 1. Remove da Fila
    $queue = read_json_file($queue_file);
    if (($key = array_search($peer_id, $queue)) !== false) {
        unset($queue[$key]);
        write_json_file($queue_file, array_values($queue));
    }

    // 2. Remove da Sala
    $rooms = read_json_file($rooms_file);
    $target_id = $rooms[$peer_id] ?? null;

    if ($target_id) {
        unset($rooms[$peer_id]);
        unset($rooms[$target_id]);
        write_json_file($rooms_file, $rooms);
        return $target_id;
    }
    return null;
}

function find_or_create_room($new_peer_id) {
    global $queue_file, $rooms_file;
    
    $queue = read_json_file($queue_file);
    $rooms = read_json_file($rooms_file);

    if (empty($queue)) {
        $queue[] = $new_peer_id;
        write_json_file($queue_file, $queue);
        return ['status' => 'waiting', 'to' => null];
        
    } else {
        $target_peer_id = array_shift($queue);
        
        $rooms[$new_peer_id] = $target_peer_id; 
        $rooms[$target_peer_id] = $new_peer_id; 
        
        write_json_file($queue_file, $queue);
        write_json_file($rooms_file, $rooms);
        
        return ['status' => 'matched', 'to' => $target_peer_id];
    }
}

function get_target_id($my_id) {
    global $rooms_file;
    $rooms = read_json_file($rooms_file);
    return $rooms[$my_id] ?? null;
}

// --- Processamento da Requisição ---

$method = $_SERVER['REQUEST_METHOD'];

// 1. POST: Enviar um sinal WebRTC ou Comando de Desconexão
if ($method === 'POST') {
    $input = file_get_contents('php://input');
    $signal = json_decode($input, true);

    if (empty($signal['senderId'])) {
         http_response_code(400);
         echo json_encode(['success' => false, 'message' => 'Sender ID é obrigatório.']);
         exit;
    }

    // A. Comando de Desconexão
    if (isset($signal['action']) && $signal['action'] === 'disconnect') {
        $disconnected_peer = $signal['senderId'];
        $partner_id = clear_room_and_queue($disconnected_peer);
        
        if ($partner_id) {
            $notification = json_encode([
                'to' => $partner_id,
                'senderId' => $disconnected_peer,
                'data' => [
                    'type' => 'room-disconnected',
                    'message' => 'Seu parceiro se desconectou.'
                ]
            ]);
            file_put_contents(get_peer_filepath($partner_id), $notification . "\n", FILE_APPEND | LOCK_EX);
        }
        echo json_encode(['success' => true, 'message' => 'Sala limpa.']);
        exit;
    }
    
    // B. Sinalização WebRTC
    if (empty($signal['to']) || empty($signal['data'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Target ID e dados são obrigatórios.']);
        exit;
    }
    
    $target_id = $signal['to'];
    $filepath = get_peer_filepath($target_id);

    $success = file_put_contents($filepath, $input . "\n", FILE_APPEND | LOCK_EX);

    if ($success !== false) {
        echo json_encode(['success' => true]);
    } else {
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Falha ao escrever no arquivo.']);
    }

} 
// 2. GET: Receber novas mensagens e buscar um par
elseif ($method === 'GET') {
    if (empty($_GET['hash'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'O parâmetro hash é obrigatório.']);
        exit;
    }
    
    $my_id = $_GET['hash'];
    $filepath = get_peer_filepath($my_id);
    $messages = [];

    // --- A. Checar por um Par ---
    $target_id = get_target_id($my_id);
    $room_status = ['to' => $target_id];

    if (!$target_id) {
        $match = find_or_create_room($my_id);
        $room_status['to'] = $match['to'];
        $room_status['status'] = $match['status'];
        
    } else {
         $room_status['status'] = 'connected';
    }

    // --- B. Checar Caixa de Correio ---
    if (file_exists($filepath)) {
        $content = file_get_contents($filepath);
        
        if (!unlink($filepath)) {
            error_log("Falha ao excluir o arquivo de sinalização: " . $filepath);
        }

        $lines = explode("\n", trim($content));
        foreach ($lines as $line) {
            if (!empty($line)) {
                $messages[] = json_decode($line, true);
            }
        }
    }

    echo json_encode([
        'success' => true, 
        'roomStatus' => $room_status,
        'messages' => $messages
    ]);

} 
else {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Método não permitido.']);
}
?>